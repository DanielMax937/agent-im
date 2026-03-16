import { ProxyAgent, setGlobalDispatcher } from 'undici';

import { loadConfig, configToSettings } from '../config';
import { initBridgeContext } from '../lib/bridge/context';
import '../lib/bridge/adapters/index.js';
import { getLogger, setupLogger } from '../logger';
import { PendingPermissions } from '../permission-gateway';
import { resolveProvider } from '../runtime-provider';
import { JsonFileStore } from '../store';
import { createPlatformApp, type PlatformApp } from './app';
import { CompensationService } from './compensation-service';
import { JsonPlatformStore } from './json-platform-store';
import { GitService } from './git-service';
import { HttpScmClient } from './scm-client';
import { InstanceManager } from './instance-manager';
import { WorkflowService } from './workflow-service';

export interface PlatformContainer {
  app: PlatformApp;
  store: JsonPlatformStore;
  workflowService: WorkflowService;
  instanceManager: InstanceManager;
}

const GLOBAL_KEY = '__agent_im_next_platform_container__';

async function createPlatformContainer(): Promise<PlatformContainer> {
  const config = loadConfig();
  const logger = setupLogger();

  if (config.proxy) {
    setGlobalDispatcher(new ProxyAgent(config.proxy));
    logger.info({ proxy: config.proxy }, 'Configured outbound proxy');
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
  logger.info('Initialized Next.js platform container');

  return {
    app: createPlatformApp({
      store,
      workflowService,
      instanceManager,
    }),
    store,
    workflowService,
    instanceManager,
  };
}

export async function getPlatformContainer(): Promise<PlatformContainer> {
  const globalState = globalThis as typeof globalThis & {
    [GLOBAL_KEY]?: Promise<PlatformContainer>;
  };

  if (!globalState[GLOBAL_KEY]) {
    globalState[GLOBAL_KEY] = createPlatformContainer();
  }

  return globalState[GLOBAL_KEY]!;
}

export function getPlatformLogger() {
  return getLogger().child({ scope: 'next-platform' });
}
