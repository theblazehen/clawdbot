// Inbound channel session recorder and last-route updater.
import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";
import type { MsgContext } from "../auto-reply/templating.js";
import type { GroupKeyResolution } from "../config/sessions/types.js";
import { normalizeSessionKeyPreservingOpaquePeerIds } from "../sessions/session-key-utils.js";
import type { InboundLastRouteUpdate } from "./session.types.js";
export type { InboundLastRouteUpdate, RecordInboundSession } from "./session.types.js";

let inboundSessionRuntimePromise: Promise<
  typeof import("../config/sessions/inbound.runtime.js")
> | null = null;

function loadInboundSessionRuntime() {
  // Keep session persistence lazy so channel SDK type paths do not load disk writers.
  inboundSessionRuntimePromise ??= import("../config/sessions/inbound.runtime.js");
  return inboundSessionRuntimePromise;
}

function shouldSkipPinnedMainDmRouteUpdate(
  pin: InboundLastRouteUpdate["mainDmOwnerPin"] | undefined,
): boolean {
  if (!pin) {
    return false;
  }
  const owner = normalizeLowercaseStringOrEmpty(pin.ownerRecipient);
  const sender = normalizeLowercaseStringOrEmpty(pin.senderRecipient);
  if (!owner || !sender || owner === sender) {
    return false;
  }
  pin.onSkip?.({ ownerRecipient: pin.ownerRecipient, senderRecipient: pin.senderRecipient });
  return true;
}

export async function recordInboundSession(params: {
  storePath: string;
  sessionKey: string;
  ctx: MsgContext;
  groupResolution?: GroupKeyResolution | null;
  createIfMissing?: boolean;
  updateLastRoute?: InboundLastRouteUpdate;
  onRecordError: (err: unknown) => void;
  trackSessionMetaTask?: (task: Promise<unknown>) => void;
}): Promise<void> {
  // Session keys may contain opaque peer ids; preserve case-sensitive payloads while normalizing shape.
  const { storePath, sessionKey, ctx, groupResolution, createIfMissing } = params;
  const canonicalSessionKey = normalizeSessionKeyPreservingOpaquePeerIds(sessionKey);
  const runtime = await loadInboundSessionRuntime();
  const metaTask = runtime
    .recordSessionMetaFromInbound({
      storePath,
      sessionKey: canonicalSessionKey,
      ctx,
      groupResolution,
      createIfMissing,
    })
    .catch(params.onRecordError);
  params.trackSessionMetaTask?.(metaTask);
  void metaTask;

  const update =
    params.updateLastRoute ??
    (() => {
      const channel =
        typeof ctx.OriginatingChannel === "string" && ctx.OriginatingChannel.trim()
          ? ctx.OriginatingChannel.trim()
          : typeof ctx.Provider === "string" && ctx.Provider.trim()
            ? ctx.Provider.trim()
            : typeof ctx.Surface === "string" && ctx.Surface.trim()
              ? ctx.Surface.trim()
              : "";
      const to =
        typeof ctx.OriginatingTo === "string" && ctx.OriginatingTo.trim()
          ? ctx.OriginatingTo.trim()
          : typeof ctx.To === "string" && ctx.To.trim()
            ? ctx.To.trim()
            : "";
      if (!channel || !to) {
        return undefined;
      }
      const accountId =
        typeof ctx.AccountId === "string" && ctx.AccountId.trim()
          ? ctx.AccountId.trim()
          : undefined;
      const threadId =
        typeof ctx.MessageThreadId === "string" && ctx.MessageThreadId.trim()
          ? ctx.MessageThreadId.trim()
          : typeof ctx.MessageThreadId === "number" && Number.isFinite(ctx.MessageThreadId)
            ? ctx.MessageThreadId
            : undefined;
      return {
        sessionKey: canonicalSessionKey,
        channel,
        to,
        accountId,
        threadId,
      };
    })();
  if (!update) {
    return;
  }
  if (shouldSkipPinnedMainDmRouteUpdate(update.mainDmOwnerPin)) {
    return;
  }
  const targetSessionKey = normalizeSessionKeyPreservingOpaquePeerIds(update.sessionKey);
  await runtime.updateLastRoute({
    storePath,
    sessionKey: targetSessionKey,
    route: update.route,
    deliveryContext: {
      channel: update.channel,
      to: update.to,
      accountId: update.accountId,
      threadId: update.threadId,
    },
    // Avoid leaking inbound origin metadata into a different target session.
    ctx: targetSessionKey === canonicalSessionKey ? ctx : undefined,
    groupResolution,
    createIfMissing,
  });
}
