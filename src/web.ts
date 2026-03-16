import { ProxyAgent, setGlobalDispatcher } from 'undici';

import { loadConfig, configToSettings } from './config.js';
import { initBridgeContext } from './lib/bridge/context.js';
import './lib/bridge/adapters/index.js';
import { setupLogger } from './logger.js';
import { PendingPermissions } from './permission-gateway.js';
import { resolveProvider } from './runtime-provider.js';
import { JsonFileStore } from './store.js';
import { createPlatformApp } from './platform/app.js';
import { CompensationService } from './platform/compensation-service.js';
import { JsonPlatformStore } from './platform/json-platform-store.js';
import { GitService } from './platform/git-service.js';
import { InstanceManager } from './platform/instance-manager.js';
import { HttpScmClient } from './platform/scm-client.js';
import { WorkflowService } from './platform/workflow-service.js';

async function main(): Promise<void> {
  const config = loadConfig();
  setupLogger();

  if (config.proxy) {
    setGlobalDispatcher(new ProxyAgent(config.proxy));
  }

  const pendingPermissions = new PendingPermissions();
  const llm = await resolveProvider({
    config,
    pendingPermissions,
  });

  initBridgeContext({
    store: new JsonFileStore(configToSettings(config)),
    llm,
    permissions: {
      resolvePendingPermission: (permissionRequestId, resolution) =>
        pendingPermissions.resolve(permissionRequestId, resolution),
    },
    lifecycle: {},
  });

  const store = new JsonPlatformStore();
  const instanceManager = InstanceManager.getInstance({
    store,
    approvalBaseUrl: process.env.CTI_WEB_BASE_URL,
  });
  const workflowService = new WorkflowService({
    store,
    gitService: new GitService(),
    scmClient: new HttpScmClient(),
    instanceManager,
    compensationService: new CompensationService(store, instanceManager),
  });

  await instanceManager.reconcile();

  const port = Number(process.env.PORT || process.env.CTI_WEB_PORT || 8787);
  const app = createPlatformApp({
    store,
    workflowService,
    instanceManager,
  });

  app.listen(port, () => {
    console.log(`[agent-im] Web platform listening on :${port}`);
  });
}

main().catch((error) => {
  console.error('[agent-im] Web platform failed to start:', error instanceof Error ? error.stack || error.message : error);
  process.exit(1);
});
