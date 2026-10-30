export {
  addWebSource,
  linkFolder,
  cancelWebSourceSync,
  listLinkedFolders,
  listWebSources,
  listWebSourcePairings,
  listWebSourceSyncJobs,
  removeWebSource,
  retryWebSourceSync,
  syncLinkedFolder,
  syncWebSources,
  unlinkFolder,
  updateWebSourceSchedule,
} from "./client";

export type {
  AddWebSourcePayload,
  BilingualPairing,
  LinkedFolderInfo,
  WebSource,
  WebSourceSchedulePayload,
  WebSourceSyncJob,
  WebSyncResult,
  WebSyncSourceResult,
} from "../model/types";
