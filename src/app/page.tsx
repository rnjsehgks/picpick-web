'use client';

import { useEffect, useState } from 'react';
import { removeBackground } from '@imgly/background-removal';
import JSZip from 'jszip';

type Mode = 'portrait-bw' | 'portrait' | 'subject';

interface ProcessedItem {
  id: string;
  file: File;
  originalUrl: string;
  rawBlob?: Blob;
  resultBlob?: Blob;
  resultUrl?: string;
  status: 'pending' | 'processing' | 'done' | 'error';
  error?: string;
}

const MODES = [
  { id: 'portrait-bw' as Mode, label: '인물 흑백', description: '사원증용' },
  { id: 'portrait' as Mode, label: '인물 컬러', description: '컬러 프로필' },
  { id: 'subject' as Mode, label: '피사체', description: '제품/사물' },
];

const MODE_CONFIG: Record<Mode, { grayscale: boolean; autoCrop: boolean; suffix: string }> = {
  'portrait-bw': { grayscale: true, autoCrop: true, suffix: '_사원증' },
  portrait: { grayscale: false, autoCrop: true, suffix: '_컬러' },
  subject: { grayscale: false, autoCrop: false, suffix: '_누끼' },
};

async function smartCropFullPerson(blob: Blob): Promise<Blob> {
  const img = await createImageBitmap(blob);
  const canvas = document.createElement('canvas');
  canvas.width = img.width;
  canvas.height = img.height;
  const ctx = canvas.getContext('2d')!;
  ctx.drawImage(img, 0, 0);

  const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const data = imageData.data;

  let top = Infinity, bottom = 0, left = Infinity, right = 0;
  let found = false;

  for (let y = 0; y < canvas.height; y++) {
    for (let x = 0; x < canvas.width; x++) {
      const i = (y * canvas.width + x) * 4;
      if (data[i + 3] > 30) {
        if (y < top) top = y;
        if (y > bottom) bottom = y;
        if (x < left) left = x;
        if (x > right) right = x;
        found = true;
      }
    }
  }

  if (!found) return blob;

  const margin = Math.floor(Math.max(right - left, bottom - top) * 0.08);
  top = Math.max(0, top - margin);
  bottom = Math.min(canvas.height, bottom + margin);
  left = Math.max(0, left - margin);
  right = Math.min(canvas.width, right + margin);

  const targetRatio = 3 / 4;
  let cropW = right - left;
  let cropH = bottom - top;

  if (cropW / cropH < targetRatio) {
    const desiredW = Math.floor(cropH * targetRatio);
    const extra = Math.floor((desiredW - cropW) / 2);
    left = Math.max(0, left - extra);
    right = Math.min(canvas.width, right + extra);
  } else {
    const desiredH = Math.floor(cropW / targetRatio);
    const extra = Math.floor((desiredH - cropH) / 2);
    top = Math.max(0, top - extra);
    bottom = Math.min(canvas.height, bottom + extra);
  }

  cropW = right - left;
  cropH = bottom - top;

  const outCanvas = document.createElement('canvas');
  outCanvas.width = cropW;
  outCanvas.height = cropH;
  const outCtx = outCanvas.getContext('2d')!;
  outCtx.drawImage(canvas, left, top, cropW, cropH, 0, 0, cropW, cropH);

  return new Promise((resolve) => {
    outCanvas.toBlob((b) => resolve(b!), 'image/png');
  });
}

async function toGrayscale(blob: Blob): Promise<Blob> {
  const img = await createImageBitmap(blob);
  const canvas = document.createElement('canvas');
  canvas.width = img.width;
  canvas.height = img.height;
  const ctx = canvas.getContext('2d')!;
  ctx.drawImage(img, 0, 0);

  const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const data = imageData.data;

  for (let i = 0; i < data.length; i += 4) {
    const gray = Math.round(0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2]);
    data[i] = data[i + 1] = data[i + 2] = gray;
  }

  ctx.putImageData(imageData, 0, 0);

  return new Promise((resolve) => {
    canvas.toBlob((b) => resolve(b!), 'image/png');
  });
}

async function applyMode(rawBlob: Blob, mode: Mode): Promise<Blob> {
  const config = MODE_CONFIG[mode];
  let result = rawBlob;
  if (config.autoCrop) result = await smartCropFullPerson(result);
  if (config.grayscale) result = await toGrayscale(result);
  return result;
}

export default function Home() {
  const [items, setItems] = useState<ProcessedItem[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [mode, setMode] = useState<Mode>('portrait-bw');
  const [processing, setProcessing] = useState(false);
  const [progress, setProgress] = useState('');
  const [statusMessage, setStatusMessage] = useState('');
  const [isDragOver, setIsDragOver] = useState(false);

  const selectedItem = items.find((i) => i.id === selectedId);
  const doneCount = items.filter((i) => i.status === 'done').length;

  useEffect(() => {
    if (items.length === 0) return;
    if (items.every((i) => !i.rawBlob)) return;

    (async () => {
      const updated = await Promise.all(
        items.map(async (item) => {
          if (!item.rawBlob) return item;
          const resultBlob = await applyMode(item.rawBlob, mode);
          if (item.resultUrl) URL.revokeObjectURL(item.resultUrl);
          const resultUrl = URL.createObjectURL(resultBlob);
          return { ...item, resultBlob, resultUrl };
        }),
      );
      setItems(updated);
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode]);

  const handleFiles = async (files: File[]) => {
    const newItems: ProcessedItem[] = files.map((file) => ({
      id: crypto.randomUUID(),
      file,
      originalUrl: URL.createObjectURL(file),
      status: 'pending' as const,
    }));

    setItems((prev) => [...prev, ...newItems]);
    if (!selectedId && newItems.length > 0) {
      setSelectedId(newItems[0].id);
    }

    setProcessing(true);

    for (let i = 0; i < newItems.length; i++) {
      const item = newItems[i];
      setProgress(`처리 중: ${i + 1}/${newItems.length} — ${item.file.name}`);

      setItems((prev) =>
        prev.map((p) =>
          p.id === item.id ? { ...p, status: 'processing' as const } : p,
        ),
      );

      try {
        const rawBlob = await removeBackground(item.file, {
          progress: (key, current, total) => {
            if (key.startsWith('fetch')) {
              const pct = Math.round((current / total) * 100);
              setProgress(`AI 모델 다운로드 중... ${pct}%`);
            }
          },
        });

        const resultBlob = await applyMode(rawBlob, mode);
        const resultUrl = URL.createObjectURL(resultBlob);

        setItems((prev) =>
          prev.map((p) =>
            p.id === item.id
              ? { ...p, rawBlob, resultBlob, resultUrl, status: 'done' as const }
              : p,
          ),
        );
      } catch (err) {
        setItems((prev) =>
          prev.map((p) =>
            p.id === item.id
              ? { ...p, status: 'error' as const, error: (err as Error).message }
              : p,
          ),
        );
      }
    }

    setProcessing(false);
    setProgress('');
  };

  const handleFileInput = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (!files) return;
    handleFiles(Array.from(files));
    e.target.value = '';
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragOver(false);
    const files = Array.from(e.dataTransfer.files).filter((f) =>
      f.type.startsWith('image/'),
    );
    if (files.length > 0) handleFiles(files);
  };

  const handleClearAll = () => {
    items.forEach((item) => {
      URL.revokeObjectURL(item.originalUrl);
      if (item.resultUrl) URL.revokeObjectURL(item.resultUrl);
    });
    setItems([]);
    setSelectedId(null);
    setStatusMessage('');
  };

  const handleDownloadSingle = () => {
    if (!selectedItem || !selectedItem.resultBlob) return;
    const url = URL.createObjectURL(selectedItem.resultBlob);
    const a = document.createElement('a');
    const baseName = selectedItem.file.name.replace(/\.[^.]+$/, '');
    a.href = url;
    a.download = `${baseName}${MODE_CONFIG[mode].suffix}.png`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    setStatusMessage('✓ 다운로드 완료');
  };

  const handleDownloadAll = async () => {
    const done = items.filter((i) => i.status === 'done' && i.resultBlob);
    if (done.length === 0) return;

    setStatusMessage('ZIP 파일 생성 중...');

    const zip = new JSZip();
    for (const item of done) {
      const baseName = item.file.name.replace(/\.[^.]+$/, '');
      zip.file(`${baseName}${MODE_CONFIG[mode].suffix}.png`, item.resultBlob!);
    }

    const blob = await zip.generateAsync({ type: 'blob' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `picpik_${done.length}장.zip`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    setStatusMessage(`✓ ${done.length}장 ZIP 다운로드 완료`);
  };

  const handleCopyToClipboard = async () => {
    if (!selectedItem || !selectedItem.resultBlob) return;
    try {
      await navigator.clipboard.write([
        new ClipboardItem({ 'image/png': selectedItem.resultBlob }),
      ]);
      setStatusMessage('✓ 클립보드에 복사됨 (⌘+V로 붙여넣기)');
    } catch (e) {
      console.error(e);
      setStatusMessage('⚠ 복사 실패');
    }
  };

  const checkerboardStyle = {
    backgroundImage: `linear-gradient(45deg, #f3f4f6 25%, transparent 25%),
      linear-gradient(-45deg, #f3f4f6 25%, transparent 25%),
      linear-gradient(45deg, transparent 75%, #f3f4f6 75%),
      linear-gradient(-45deg, transparent 75%, #f3f4f6 75%)`,
    backgroundSize: '20px 20px',
    backgroundPosition: '0 0, 0 10px, 10px -10px, 10px 0px',
  };

  return (
    <main className="min-h-screen bg-gray-50 px-4 py-10">
      <div className="max-w-5xl mx-auto">
        <div className="flex flex-col items-center mb-10">
          <img src="/logo.png" alt="picpik" className="h-10 mb-3" />
          <p className="text-sm text-gray-500">
            프로필 사진 누끼 · 흑백 변환 자동화
          </p>
        </div>

        {/* STEP 01 */}
        <div className="bg-white rounded-2xl shadow-sm border border-gray-100 p-6 mb-4">
          <div className="flex items-center gap-2 mb-4">
            <span className="text-[10px] font-semibold tracking-wider text-gray-500 bg-gray-100 px-2 py-1 rounded">
              STEP 01
            </span>
            <h2 className="text-base font-semibold text-gray-900">사진 선택</h2>
          </div>

          <div className="mb-4">
            <p className="text-xs text-gray-500 mb-2">처리 모드</p>
            <div className="grid grid-cols-3 gap-2">
              {MODES.map((m) => (
                <button
                  key={m.id}
                  onClick={() => setMode(m.id)}
                  disabled={processing}
                  className={`px-3 py-2.5 rounded-lg text-sm font-medium transition border ${
                    mode === m.id
                      ? 'bg-gray-900 text-white border-gray-900'
                      : 'bg-white text-gray-700 border-gray-200 hover:border-gray-300'
                  } disabled:opacity-50`}
                >
                  <div>{m.label}</div>
                  <div className={`text-[10px] mt-0.5 ${mode === m.id ? 'text-gray-300' : 'text-gray-400'}`}>
                    {m.description}
                  </div>
                </button>
              ))}
            </div>
          </div>

          <div
            onDrop={handleDrop}
            onDragOver={(e) => { e.preventDefault(); setIsDragOver(true); }}
            onDragLeave={() => setIsDragOver(false)}
            className={`border-2 border-dashed rounded-xl p-8 text-center transition ${
              isDragOver ? 'border-gray-900 bg-gray-50' : 'border-gray-200 hover:border-gray-300'
            }`}
          >
            <p className="text-sm text-gray-500 mb-3">
              사진을 여기로 드래그하거나
            </p>
            <label className="inline-block">
              <input
                type="file"
                accept="image/*"
                multiple
                onChange={handleFileInput}
                disabled={processing}
                className="hidden"
              />
              <span className="inline-block px-5 py-2.5 rounded-lg text-sm font-medium bg-gray-900 text-white hover:bg-gray-700 cursor-pointer">
                파일 선택
              </span>
            </label>
            <p className="text-xs text-gray-400 mt-3">여러 장 한 번에 선택 가능</p>
          </div>

          {progress && (
            <div className="mt-4 text-sm text-gray-600 bg-gray-50 px-3 py-2 rounded-md">
              {progress}
            </div>
          )}
        </div>

        {/* STEP 02 */}
        {items.length > 0 && (
          <div className="bg-white rounded-2xl shadow-sm border border-gray-100 p-6 mb-4">
            <div className="flex items-center justify-between mb-4">
              <div className="flex items-center gap-2">
                <span className="text-[10px] font-semibold tracking-wider text-gray-500 bg-gray-100 px-2 py-1 rounded">
                  STEP 02
                </span>
                <h2 className="text-base font-semibold text-gray-900">
                  미리보기 ({doneCount}/{items.length})
                </h2>
              </div>
              <button
                onClick={handleClearAll}
                className="text-xs text-gray-500 hover:text-gray-700"
              >
                모두 지우기
              </button>
            </div>

            <div className="grid grid-cols-[1fr_3fr] gap-4">
              <div className="border border-gray-100 rounded-lg overflow-hidden">
                <p className="text-xs text-gray-500 px-3 py-2 bg-gray-50 border-b border-gray-100">
                  처리 목록
                </p>
                <div className="max-h-[400px] overflow-y-auto">
                  {items.map((item) => (
                    <button
                      key={item.id}
                      onClick={() => setSelectedId(item.id)}
                      className={`w-full text-left px-3 py-2 text-sm border-b border-gray-100 last:border-0 truncate flex items-center justify-between gap-2 ${
                        selectedId === item.id
                          ? 'bg-gray-100 text-gray-900'
                          : 'hover:bg-gray-50 text-gray-700'
                      }`}
                    >
                      <span className="truncate flex-1">{item.file.name}</span>
                      <span className="flex-shrink-0 text-xs">
                        {item.status === 'done' && '✓'}
                        {item.status === 'processing' && '⟳'}
                        {item.status === 'pending' && '·'}
                        {item.status === 'error' && '✗'}
                      </span>
                    </button>
                  ))}
                </div>
              </div>

              <div className="grid grid-cols-2 gap-4">
                <div>
                  <p className="text-xs text-gray-500 mb-2">원본</p>
                  {selectedItem ? (
                    <img
                      src={selectedItem.originalUrl}
                      alt="원본"
                      className="w-full h-auto rounded-lg border border-gray-100"
                    />
                  ) : (
                    <div className="aspect-[3/4] bg-gray-50 rounded-lg border border-gray-100" />
                  )}
                </div>
                <div>
                  <p className="text-xs text-gray-500 mb-2">처리 결과</p>
                  {selectedItem?.resultUrl ? (
                    <img
                      src={selectedItem.resultUrl}
                      alt="결과"
                      className="w-full h-auto rounded-lg border border-gray-100"
                      style={checkerboardStyle}
                    />
                  ) : selectedItem?.status === 'processing' ? (
                    <div className="aspect-[3/4] bg-gray-50 rounded-lg border border-gray-100 flex items-center justify-center text-gray-400 text-sm">
                      처리 중...
                    </div>
                  ) : selectedItem?.status === 'error' ? (
                    <div className="aspect-[3/4] bg-gray-50 rounded-lg border border-gray-100 flex items-center justify-center text-red-400 text-sm p-4 text-center">
                      오류: {selectedItem.error}
                    </div>
                  ) : (
                    <div className="aspect-[3/4] bg-gray-50 rounded-lg border border-gray-100" />
                  )}
                </div>
              </div>
            </div>
          </div>
        )}

        {/* STEP 03 */}
        {doneCount > 0 && (
          <div className="bg-white rounded-2xl shadow-sm border border-gray-100 p-6">
            <div className="flex items-center gap-2 mb-4">
              <span className="text-[10px] font-semibold tracking-wider text-gray-500 bg-gray-100 px-2 py-1 rounded">
                STEP 03
              </span>
              <h2 className="text-base font-semibold text-gray-900">저장</h2>
            </div>

            {statusMessage && (
              <div className="mb-3 text-sm text-gray-600 bg-gray-50 px-3 py-2 rounded-md">
                {statusMessage}
              </div>
            )}

            <div className="grid grid-cols-3 gap-3">
              <button
                onClick={handleCopyToClipboard}
                disabled={!selectedItem?.resultBlob}
                className="px-4 py-3 rounded-lg text-sm font-medium border border-gray-200 bg-white text-gray-700 hover:bg-gray-50 transition disabled:opacity-50"
              >
                선택 항목 복사
              </button>
              <button
                onClick={handleDownloadSingle}
                disabled={!selectedItem?.resultBlob}
                className="px-4 py-3 rounded-lg text-sm font-medium border border-gray-200 bg-white text-gray-700 hover:bg-gray-50 transition disabled:opacity-50"
              >
                선택 항목 다운로드
              </button>
              <button
                onClick={handleDownloadAll}
                disabled={doneCount === 0}
                className="px-4 py-3 rounded-lg text-sm font-medium bg-gray-900 text-white hover:bg-gray-700 transition disabled:opacity-50"
              >
                전체 ZIP 다운로드 ({doneCount}장)
              </button>
            </div>
          </div>
        )}
      </div>
    </main>
  );
}
