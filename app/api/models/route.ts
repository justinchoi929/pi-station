import { existsSync } from "fs";
import { stat } from "fs/promises";
import { resolve } from "path";
import { PiCliSession } from "@/lib/pi-cli-session";
import type { Api, Model } from "@earendil-works/pi-ai";
import { getSupportedThinkingLevels } from "@earendil-works/pi-ai";
import {
  loadModelsWithCache,
  withModelRuntimeError,
  withSafeModelLoadFailure,
  type ModelsData,
} from "@/lib/models-cache";
import { getAllowedFileRoots, isExistingFilePathAllowed } from "@/lib/file-access";
import { inferRemovedWorktree } from "@/lib/worktree";

export const dynamic = "force-dynamic";

async function loadModels(cwd: string): Promise<ModelsData> {
  // Discovery runs in the same installed CLI as chat. No history is written,
  // and merely opening a selector does not connect MCP servers.
  const session = await PiCliSession.create({ cwd, ephemeral: true, offline: true, disableMcp: true });
  try {
    const catalog = await session.send({ type: "get_model_catalog" }) as {
      models: Model<Api>[];
      defaultModel?: Model<Api>;
      defaultThinkingLevel: string;
      savedDefaultThinkingLevel: string | null;
      thinkingLevelPins: Record<string, string>;
      modelError?: string;
    };
    const thinkingLevels: Record<string, string[]> = {};
    const thinkingLevelMaps: Record<string, Record<string, string | null>> = {};
    const models: Record<string, string> = {};
    for (const model of catalog.models) {
      const key = `${model.provider}:${model.id}`;
      models[key] = model.name;
      thinkingLevels[key] = getSupportedThinkingLevels(model);
      if (model.thinkingLevelMap) thinkingLevelMaps[key] = model.thinkingLevelMap;
    }
    return withModelRuntimeError({
      models,
      modelList: catalog.models.map(({ id, name, provider, input }) => ({ id, name, provider, input })),
      defaultModel: catalog.defaultModel ? { provider: catalog.defaultModel.provider, modelId: catalog.defaultModel.id } : null,
      defaultThinkingLevel: catalog.defaultThinkingLevel,
      savedDefaultThinkingLevel: catalog.savedDefaultThinkingLevel,
      thinkingLevels,
      thinkingLevelMaps,
      thinkingLevelPins: catalog.thinkingLevelPins,
    }, catalog.modelError);
  } finally {
    await session.shutdown();
  }
}

const EMPTY_MODELS: ModelsData = {
  models: {},
  modelList: [],
  defaultModel: null,
  defaultThinkingLevel: null,
  savedDefaultThinkingLevel: null,
  thinkingLevels: {},
  thinkingLevelMaps: {},
  thinkingLevelPins: {},
};

export async function GET(req: Request) {
  const requestedCwd = resolve(new URL(req.url).searchParams.get("cwd") || process.cwd());
  // A subagent run isolated in a worktree has that worktree removed when the run
  // finishes, yet its session file still records the worktree as its cwd. Fall back
  // to the main repo it branched from, so opening a finished subagent resolves the
  // same models a non-isolated one would. The roots check below runs on the folder
  // actually answered from, so the fallback reaches no project that was not allowed
  // by name already.
  const cwd = existsSync(requestedCwd)
    ? requestedCwd
    : inferRemovedWorktree(requestedCwd)?.projectRoot ?? requestedCwd;

  let cwdStat;
  try {
    cwdStat = await stat(cwd);
  } catch {
    return Response.json({ error: `Directory does not exist: ${cwd}` }, { status: 400 });
  }
  if (!cwdStat.isDirectory()) {
    return Response.json({ error: `Not a directory: ${cwd}` }, { status: 400 });
  }
  const allowedRoots = await getAllowedFileRoots();
  if (!isExistingFilePathAllowed(cwd, allowedRoots)) {
    return Response.json({ error: "Access denied" }, { status: 403 });
  }

  try {
    return Response.json(await loadModelsWithCache(cwd, () => loadModels(cwd)));
  } catch {
    return Response.json(withSafeModelLoadFailure(EMPTY_MODELS));
  }
}
