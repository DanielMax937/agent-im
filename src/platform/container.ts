import { ProxyAgent, setGlobalDispatcher } from 'undici';

import {
  loadKanbanPlatformConfig,
  getKanbanPlatformCtiHome,
  configToSettings,
  syncConfigFileToProcessEnv,
  normalizeRunners,
  normalizeRunnersForChannelType,
  defaultRunnerIdForChannelType,
} from '../config';
import { buildImBridgeLlmStack } from '../lib/bridge/llm-registry';
import { initBridgeContext } from '../lib/bridge/context';
import '../lib/bridge/adapters/index';
import { getLogger, setupLogger } from '../logger';
import { PendingPermissions } from '../permission-gateway';
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
  const kanbanHome = getKanbanPlatformCtiHome();
  const config = loadKanbanPlatformConfig();
  // Loads `kanban/config.env` into process.env + applies CTI_PROXY→HTTP_PROXY (see syncConfigFileToProcessEnv).
  // Lane runners use resolveProvider → buildSubprocessEnv() which inherits this (same as Auto bridge).
  syncConfigFileToProcessEnv(kanbanHome);
  const logger = setupLogger();

  if (config.proxy) {
    setGlobalDispatcher(new ProxyAgent(config.proxy));
    logger.info({ proxy: config.proxy }, 'Configured outbound proxy');
  }

  const pendingPermissions = new PendingPermissions();
  const { defaultLlm, resolveLlmForBinding } = await buildImBridgeLlmStack(config, pendingPermissions);
  const bridgeRunners = normalizeRunners(config);
  const bridgeDefaultRunnerId = config.defaultRunnerId ?? bridgeRunners[0]?.id;

  initBridgeContext({
    store: new JsonFileStore(configToSettings(config)),
    llm: defaultLlm,
    resolveLlmForBinding,
    getRunnerConfigsForChannelType: (channelType) =>
      normalizeRunnersForChannelType(loadKanbanPlatformConfig(), channelType),
    getDefaultRunnerIdForChannelType: (channelType) =>
      defaultRunnerIdForChannelType(loadKanbanPlatformConfig(), channelType),
    imRunners: bridgeRunners.map((p) => ({
      id: p.id,
      runtime: p.runtime,
      label: p.label,
    })),
    imRunnerConfigs: bridgeRunners,
    defaultRunnerId: bridgeDefaultRunnerId,
    permissions: {
      resolvePendingPermission: (permissionRequestId, resolution) =>
        pendingPermissions.resolve(permissionRequestId, resolution),
    },
    lifecycle: {},
  });

  const store = new JsonPlatformStore();
  let workflowService: WorkflowService;
  const instanceManager = InstanceManager.getInstance({
    store,
    onAgentTurnComplete: async (taskSessionId, role, instanceId) => {
      await workflowService.afterSuccessfulAssistantTurn(taskSessionId, role, instanceId);
    },
  });
  workflowService = new WorkflowService({
    store,
    gitService: new GitService(),
    scmClient: new HttpScmClient(),
    instanceManager,
    compensationService: new CompensationService(store, instanceManager),
  });

  await workflowService.resumeKanbanAfterRestart();

  const queuePollRaw = process.env.CTI_KANBAN_QUEUE_POLL_MS ?? '5000';
  const queuePollMs = parseInt(queuePollRaw, 10);
  if (Number.isFinite(queuePollMs) && queuePollMs > 0) {
    const interval = setInterval(() => {
      void workflowService.processAllDeveloperAssignmentQueues().catch((err) => {
        logger.warn({ err }, 'Kanban developer queue poll failed');
      });
    }, queuePollMs);
    if (typeof interval.unref === 'function') interval.unref();
    logger.info({ ms: queuePollMs }, 'Kanban developer queue poll enabled');
  }

  const vercelPollRaw = process.env.CTI_KANBAN_VERCEL_POLL_MS ?? '30000';
  const vercelPollMs = parseInt(vercelPollRaw, 10);
  if (Number.isFinite(vercelPollMs) && vercelPollMs > 0) {
    const interval = setInterval(() => {
      void workflowService.pollVercelDeployments().catch((err) => {
        logger.warn({ err }, 'Kanban Vercel deployment poll failed');
      });
    }, vercelPollMs);
    if (typeof interval.unref === 'function') interval.unref();
    logger.info({ ms: vercelPollMs }, 'Kanban Vercel deployment poll enabled');
  }

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
