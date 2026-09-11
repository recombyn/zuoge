import { useEffect, useRef, memo } from 'react';
import { useSelector } from '@/store';
import { message } from '@/components/base';
import {
  formatProcessProgressLabel,
  readProcessJobIds,
  stripProcessProgressLabel,
  uploadRecoveryBlockReason,
  uploadRecoveryFailMessage,
} from '@/components/rcb/scene/document/processJobAttrs';
import { resumeOrWaitUploadJob } from '@/service/uploadJobs';
import { getHttpErrorMessage } from '@/service/client';
import { buildUploadFinishAttrs, ensureDurableVideoFinishAttrs } from '@/utils/canvasUploadFlow';
import {
  hasActiveNodeUpload,
  isUploadAbortError,
  waitForImageReady,
} from '@/utils/uploadImage';
import {
  failImageProcess,
  finishImageProcess,
  patchDocumentNode,
} from '@/store/modules/editor';
import type { SceneDocument } from '@/components/rcb/sceneNode';

function UploadJobWatcher() {
  const pendingId = useSelector(
    (s: { editor?: { pendingImageProcessId?: string | null } }) =>
      s.editor?.pendingImageProcessId ?? null
  );
  const document = useSelector(
    (s: { editor?: { document?: SceneDocument } }) => s.editor?.document
  );
  const documentRef = useRef(document);
  documentRef.current = document;

  useEffect(() => {
    if (!pendingId) return undefined;
    const node = documentRef.current?.deltaSetLike?.[pendingId];
    if (String(node?.attrs?.processKind || '') !== 'upload') return undefined;
    if (hasActiveNodeUpload(pendingId)) return undefined;

    let cancelled = false;
    const ac = new AbortController();
    const jobIds = readProcessJobIds(node);

    const fail = (msg: string) => {
      if (cancelled) return;
      message.error(msg);
      failImageProcess({ nodeId: pendingId });
    };

    const run = async () => {
      const liveDoc = documentRef.current;
      const liveNode = liveDoc?.deltaSetLike?.[pendingId] || node;
      const block = uploadRecoveryBlockReason(liveNode);
      if (block) {
        fail(uploadRecoveryFailMessage(block));
        return;
      }

      const labelBase = stripProcessProgressLabel(
        String(liveNode?.attrs?.processLabel || ''),
        '上传中'
      );
      const assetKind = String(liveNode?.attrs?.assetKind || '').trim();
      const isRaster = assetKind !== 'video' && assetKind !== 'audio';

      try {
        const uploaded = await resumeOrWaitUploadJob(jobIds[0], {
          signal: ac.signal,
          onProgress: (pct) => {
            if (cancelled) return;
            patchDocumentNode({
                nodeId: pendingId,
                skipHistory: true,
                skipHostReload: true,
                patch: {
                  attrs: { processLabel: formatProcessProgressLabel(labelBase, pct, '上传中') },
                },
              });
          },
        });
        if (cancelled) return;

        const remoteReady = isRaster
          ? await waitForImageReady(uploaded.url, { signal: ac.signal })
          : true;
        if (cancelled) return;

        const finishNode = documentRef.current?.deltaSetLike?.[pendingId] || liveNode;
        const finishAttrs = await ensureDurableVideoFinishAttrs(
          buildUploadFinishAttrs(finishNode?.attrs, uploaded),
          ac.signal
        );
        if (cancelled) return;
        finishImageProcess({
            nodeId: pendingId,
            ...(remoteReady ? { src: uploaded.url } : {}),
            attrs: finishAttrs,
          });
      } catch (err: unknown) {
        if (cancelled || isUploadAbortError(err)) return;
        fail(getHttpErrorMessage(err, '上传失败'));
      }
    };

    run();
    return () => {
      cancelled = true;
      ac.abort();
    };
  }, [pendingId]);

  return null;
}

export default memo(UploadJobWatcher);
