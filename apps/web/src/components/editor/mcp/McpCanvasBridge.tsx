/**
 * Live editor bridge for MCP canvas control:
 * - heartbeat → server routes ops to live queue (full designTools parity)
 * - pending batches → applyAgentToolOps (same stagger + canvas lock as Design Agent)
 * - revision reload when headless writes land
 */
import { useCallback, useEffect, useRef } from 'react';
import store from '@/store';
import { useActiveFrameId } from '@/store/editorSelectors';
import { applyAgentToolOps } from '@/components/editor/panels/agent/runDesignAgent';
import { importDocument } from '@/store/modules/editor';
import { fetchProject } from '@/service/projects';
import {
  mcpCanvasAckPending,
  mcpCanvasFetchPending,
  mcpCanvasHeartbeat,
} from '@/service/mcpCanvas';

type Props = {
  projectId: string | null | undefined;
  enabled?: boolean;
  pollMs?: number;
};

export function McpCanvasBridge({
  projectId,
  enabled = true,
  pollMs = 1500,
}: Props) {
  const activeFrameId = useActiveFrameId();
  const lastRev = useRef<number | null>(null);
  const applying = useRef(false);
  const activeFrameIdRef = useRef(activeFrameId);
  activeFrameIdRef.current = activeFrameId;

  const reloadIfRevisionBumped = useCallback(
    async (pid: string) => {
      try {
        const row = await fetchProject(pid);
        const proj = row?.project;
        const rev = Number(proj?.revision);
        if (!Number.isFinite(rev)) return;
        if (lastRev.current == null) {
          lastRev.current = rev;
          return;
        }
        if (rev > lastRev.current && proj?.document) {
          lastRev.current = rev;
          importDocument({
              id: pid,
              name: proj.name || 'Untitled',
              document: proj.document,
              source: 'user',
            });
        }
      } catch {
        /* ignore */
      }
    }, []
  );

  const applyPending = useCallback(
    async (pid: string) => {
      if (applying.current) return;
      if (!store.getState().editor.document) return;
      applying.current = true;
      try {
        const batches = await mcpCanvasFetchPending(pid, 8);
        if (!batches.length) return;
        const ackIds: string[] = [];
        for (const batch of batches) {
          const bid = String(batch.batchId || '').trim();
          const ops = Array.isArray(batch.ops) ? batch.ops : [];
          if (ops.length) {
            await applyAgentToolOps({
              ops,
              getDocument: () => store.getState().editor.document,
              frameId: activeFrameIdRef.current || null,
              source: 'ai',
            });
          }
          if (bid) ackIds.push(bid);
        }
        if (ackIds.length) await mcpCanvasAckPending(pid, ackIds);
      } finally {
        applying.current = false;
      }
    }, []
  );

  useEffect(() => {
    const pid = String(projectId || '').trim();
    if (!enabled || !pid) return;

    let cancelled = false;

    const tick = async () => {
      if (cancelled) return;
      try {
        await mcpCanvasHeartbeat(pid);
      } catch {
        /* MCP disabled or offline */
      }
      await applyPending(pid);
      await reloadIfRevisionBumped(pid);
    };

    void tick();
    const poll = window.setInterval(() => void tick(), pollMs);
    return () => {
      cancelled = true;
      window.clearInterval(poll);
    };
  }, [projectId, enabled, pollMs, applyPending, reloadIfRevisionBumped]);

  return null;
}
