import { useEffect, type RefObject } from 'react';

import {
  measureImageNaturalSize,
  parseLottieAnimationData,
  resolveMediaPlaceNatural,
  fitMediaIntoViewport,
  type MediaPlaceKind,
} from '@/components/rcb/scene/document/nodeFactories';
import { sceneToDocumentCoords } from '@/components/rcb/scene/layout/coords';
import { rcbCenterOnPoint, type RcbCamera } from '@/components/rcb';
import {
  isUploadAbortError,
  toDisplayMediaUrl,
} from '@/utils/uploadImage';
import { uploadCanvasPlaceholderSrc } from '@/utils/canvasUploadFlow';
import {
  dataTransferHasChatImage,
  dataTransferHasMediaAsset,
  readChatImageDragUrl,
  readMediaAssetDragPayload,
  clearMediaAssetDragData,
  LOTTIE_INLINE_DRAG_SRC,
  type MediaAssetDragPayload,
} from '@/utils/chatImageDrag';
import { getHttpErrorMessage } from '@/service/client';
import { message } from '@/components/base';
import { warnIfAvBlockedByAnimationWorkbenchFocus } from '@/components/editor/nodes/AnimationNode/animationWorkbenchFocus';
import store from '@/store';
import {
  failImageProcess,
  placeMediaAsset,
  startImageUploadPlaceholder,
} from '@/store/modules/editor';
import { pointerToWorld, type ArtboardRect } from '../pointerToWorld';
import { getDocumentGridSize, snapCoordToGrid } from '@/components/rcb';

type UseChatImageDropArgs = {
  readOnly: boolean;
  camera: RcbCamera;
  artboard?: ArtboardRect;
  viewportEl: HTMLElement | null;
  stageEl: HTMLElement | null;
  paperEl: HTMLElement | null;
  documentRef: RefObject<any>;
  imageSizeForViewport: (natural: { width: number; height: number }) => {
    width: number;
    height: number;
  };
  finishToSelect: () => void;
};

async function resolveAssetPlaceSize(
  payload: MediaAssetDragPayload,
  imageSizeForViewport: (natural: { width: number; height: number }) => {
    width: number;
    height: number;
  }
): Promise<{ width: number; height: number }> {
  const kind = String(payload.kind || 'image').trim().toLowerCase() as MediaPlaceKind;
  let imageNatural: { width: number; height: number } | undefined;
  if (kind === 'image') {
    const ow = Math.max(0, Math.round(Number(payload.width) || 0));
    const oh = Math.max(0, Math.round(Number(payload.height) || 0));
    if (!(ow > 0 && oh > 0) && payload.src) {
      imageNatural = await measureImageNaturalSize(payload.src);
    }
  }
  if (kind === 'lottie' && payload.animationData) {
    const aw = Math.max(1, Math.round(Number(payload.animationData.w) || 0));
    const ah = Math.max(1, Math.round(Number(payload.animationData.h) || 0));
    if (aw > 0 && ah > 0) {
      return fitMediaIntoViewport(
        kind,
        { width: aw, height: ah },
        imageSizeForViewport
      );
    }
  }
  const natural = resolveMediaPlaceNatural(kind, payload, imageNatural);
  return fitMediaIntoViewport(kind, natural, imageSizeForViewport);
}

/** Resolve a displayable canvas src. Prefer inline data: (list thumbs) — no extra fetch. */
async function hydrateAssetSrcForCanvas(
  payload: MediaAssetDragPayload
): Promise<{ src: string; uploadKey?: string; animationData?: Record<string, unknown> }> {
  const src = String(payload.src || '').trim();
  const uploadKey = String(payload.uploadKey || '').trim() || undefined;

  if (payload.kind === 'lottie') {
    const fromList = parseLottieAnimationData(payload.animationData);
    if (fromList) {
      return { src: src || LOTTIE_INLINE_DRAG_SRC, uploadKey, animationData: fromList };
    }
    if (!src || src === LOTTIE_INLINE_DRAG_SRC) {
      throw new Error('lottie asset missing animationData');
    }
  }

  if (!src || src === LOTTIE_INLINE_DRAG_SRC) return { src: '', uploadKey };

  // Place with the URL we got — no auth-fetch / blob round-trip.
  return { src: toDisplayMediaUrl(src, uploadKey), uploadKey };
}

/** Drag chat gallery images / Assets dock media onto the canvas. */
export function useChatImageDrop(args: UseChatImageDropArgs) {
  const {
    readOnly,
    camera,
    artboard,
    viewportEl,
    stageEl,
    paperEl,
    documentRef,
    imageSizeForViewport,
    finishToSelect,
  } = args;  useEffect(() => {
    const hitEl = stageEl || paperEl;
    if (readOnly || !hitEl) return undefined;

    const onDragOver = (e: DragEvent) => {
      if (
        !dataTransferHasMediaAsset(e.dataTransfer) &&
        !dataTransferHasChatImage(e.dataTransfer)
      ) {
        return;
      }
      e.preventDefault();
      if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
    };

    const placeHostedAsset = async (
      payload: MediaAssetDragPayload,
      clientX: number,
      clientY: number
    ) => {
      if (
        (payload.kind === 'video' || payload.kind === 'audio') &&
        warnIfAvBlockedByAnimationWorkbenchFocus(message.warning)
      ) {
        return;
      }
      const hydrated = await hydrateAssetSrcForCanvas(payload);
      const placePayload = {
        ...payload,
        src: hydrated.src,
        uploadKey: hydrated.uploadKey,
      };
      const { width, height } = await resolveAssetPlaceSize(
        placePayload,
        imageSizeForViewport
      );
      const world = pointerToWorld(
        camera,
        { viewportEl, stageEl, paperEl, artboard },
        clientX,
        clientY
      );
      const placed = rcbCenterOnPoint(world, { width, height });
      const latest = documentRef.current;
      if (!latest) return;
      const rawOrigin = sceneToDocumentCoords(latest, placed.left, placed.top);
      const grid = getDocumentGridSize(latest);
      const origin = {
        x: snapCoordToGrid(rawOrigin.x, grid),
        y: snapCoordToGrid(rawOrigin.y, grid),
      };
      const prompt = String(placePayload.prompt || '').trim();
      placeMediaAsset({
          kind: placePayload.kind,
          src: placePayload.src,
          uploadKey: placePayload.uploadKey || undefined,
          width,
          height,
          prompt: prompt || undefined,
          name:
            String(placePayload.name || '').trim() ||
            prompt.slice(0, 40) ||
            undefined,
          duration: placePayload.duration,
          x: origin.x,
          y: origin.y,
          ...(hydrated.animationData
            ? { animationData: hydrated.animationData }
            : {}),
        });
      finishToSelect();
    };

    const placeChatImage = async (url: string, clientX: number, clientY: number) => {
      const natural = await measureImageNaturalSize(url);
      const { width, height } = imageSizeForViewport(natural);
      const world = pointerToWorld(
        camera,
        { viewportEl, stageEl, paperEl, artboard },
        clientX,
        clientY
      );
      const placed = rcbCenterOnPoint(world, { width, height });
      const latest = documentRef.current;
      if (!latest) return;
      const rawOrigin = sceneToDocumentCoords(latest, placed.left, placed.top);
      const grid = getDocumentGridSize(latest);
      const origin = {
        x: snapCoordToGrid(rawOrigin.x, grid),
        y: snapCoordToGrid(rawOrigin.y, grid),
      };
      startImageUploadPlaceholder({
          src: url,
          width,
          height,
          x: origin.x,
          y: origin.y,
          label: '上传中',
          name: 'Image',
        });
      finishToSelect();
      const spawnedId = String(
        (store.getState() as any).editor?.pendingImageProcessId || ''
      );
      await uploadCanvasPlaceholderSrc({
        nodeId: spawnedId,
        src: url,
        filename: 'chat-image.png',
      });
    };

    const onDrop = async (e: DragEvent) => {
      const asset = readMediaAssetDragPayload(e.dataTransfer);
      if (asset) {
        e.preventDefault();
        e.stopPropagation();
        clearMediaAssetDragData();
        try {
          await placeHostedAsset(asset, e.clientX, e.clientY);
        } catch (err: any) {
          message.error(getHttpErrorMessage(err, '放置失败'));
        }
        return;
      }

      const url = readChatImageDragUrl(e.dataTransfer);
      if (!url) return;
      e.preventDefault();
      e.stopPropagation();
      try {
        await placeChatImage(url, e.clientX, e.clientY);
      } catch (err: any) {
        if (isUploadAbortError(err)) return;
        failImageProcess({});
        message.error(getHttpErrorMessage(err, '图片上传失败'));
      }
    };

    hitEl.addEventListener('dragover', onDragOver);
    hitEl.addEventListener('drop', onDrop);
    return () => {
      hitEl.removeEventListener('dragover', onDragOver);
      hitEl.removeEventListener('drop', onDrop);
    };
  }, [
    artboard,
    camera, documentRef,
    finishToSelect,
    imageSizeForViewport,
    paperEl,
    readOnly,
    stageEl,
    viewportEl,
  ]);
}
