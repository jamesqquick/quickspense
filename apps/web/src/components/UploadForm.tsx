import { useState, useRef, useCallback } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Camera, Upload, X } from "lucide-react";
import {
  UploadProcessingOverlay,
  type FileItem,
} from "./UploadProcessingOverlay";

const ALLOWED_TYPES = ["image/jpeg", "image/png", "image/webp"];
const MAX_FILE_SIZE = 10 * 1024 * 1024;
const MAX_FILE_COUNT = 10;

function validateFile(f: File): string | null {
  if (!ALLOWED_TYPES.includes(f.type)) {
    return "File must be JPEG, PNG, or WEBP";
  }
  if (f.size > MAX_FILE_SIZE) {
    return "File must be under 10MB";
  }
  return null;
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function UploadForm() {
  const [items, setItems] = useState<FileItem[]>([]);
  const [dragOver, setDragOver] = useState(false);
  const [overlayOpen, setOverlayOpen] = useState(false);
  const [overlayItems, setOverlayItems] = useState<FileItem[]>([]);
  const inputRef = useRef<HTMLInputElement>(null);
  const cameraRef = useRef<HTMLInputElement>(null);

  const addFiles = useCallback(
    (files: File[]) => {
      if (overlayOpen) return;

      setItems((prev) => {
        const remainingSlots = MAX_FILE_COUNT - prev.length;
        if (remainingSlots <= 0) {
          toast.error(`Maximum ${MAX_FILE_COUNT} files allowed`);
          return prev;
        }

        const accepted: FileItem[] = [];
        const rejections: string[] = [];

        for (const f of files) {
          if (accepted.length >= remainingSlots) {
            rejections.push(`${f.name}: batch limit of ${MAX_FILE_COUNT} reached`);
            continue;
          }
          const validationError = validateFile(f);
          if (validationError) {
            rejections.push(`${f.name}: ${validationError}`);
            continue;
          }
          accepted.push({
            id: `${f.name}-${f.size}-${f.lastModified}-${Math.random().toString(36).slice(2, 8)}`,
            file: f,
            preview: URL.createObjectURL(f),
            status: "pending",
          });
        }

        if (rejections.length > 0) {
          toast.error(rejections.join("; "));
        }

        return [...prev, ...accepted];
      });
    },
    [overlayOpen],
  );

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      setDragOver(false);
      if (overlayOpen) return;
      const files = Array.from(e.dataTransfer.files);
      if (files.length > 0) addFiles(files);
    },
    [addFiles, overlayOpen],
  );

  const removeItem = useCallback(
    (id: string) => {
      if (overlayOpen) return;
      setItems((prev) => {
        const target = prev.find((i) => i.id === id);
        if (target) URL.revokeObjectURL(target.preview);
        return prev.filter((i) => i.id !== id);
      });
    },
    [overlayOpen],
  );

  const handleSubmit = () => {
    const pending = items.filter((i) => i.status === "pending");
    if (pending.length === 0) return;

    setOverlayItems(pending);
    setOverlayOpen(true);
  };

  const handleOverlayComplete = useCallback((successIds: string[]) => {
    if (successIds.length === 1) {
      window.location.href = `/expenses/${successIds[0]}`;
    } else if (successIds.length > 1) {
      window.location.href = "/expenses?status=needs_review";
    }
  }, []);

  const handleOverlayError = useCallback(() => {
    setOverlayOpen(false);
    setOverlayItems([]);
  }, []);

  const totalSize = items.reduce((sum, i) => sum + i.file.size, 0);
  const pendingCount = items.filter((i) => i.status === "pending").length;
  const hasItems = items.length > 0;
  const canSubmit = !overlayOpen && pendingCount > 0;
  const canAddFiles = !overlayOpen && items.length < MAX_FILE_COUNT;

  return (
    <div className="space-y-4">
      {/* Mobile: Take Photo button */}
      <Button
        type="button"
        onClick={() => {
          if (canAddFiles) cameraRef.current?.click();
        }}
        disabled={!canAddFiles}
        className="sm:hidden w-full py-4 text-base"
      >
        <Camera className="size-6" />
        Take Photo
      </Button>
      <input
        ref={cameraRef}
        type="file"
        accept="image/*"
        capture="environment"
        className="hidden"
        disabled={overlayOpen}
        onChange={(e) => {
          const files = Array.from(e.target.files ?? []);
          if (files.length > 0) addFiles(files);
          e.target.value = "";
        }}
      />

      {/* Drop zone / file picker */}
      <div
        onDragOver={(e) => {
          e.preventDefault();
          if (!overlayOpen) setDragOver(true);
        }}
        onDragLeave={() => setDragOver(false)}
        onDrop={handleDrop}
        onClick={() => {
          if (canAddFiles) inputRef.current?.click();
        }}
        className={`border-2 border-dashed rounded-2xl p-6 sm:p-12 text-center transition-colors duration-200 ${
          overlayOpen || items.length >= MAX_FILE_COUNT
            ? "cursor-not-allowed opacity-60 border-white/20 bg-white/5"
            : dragOver
              ? "cursor-pointer border-primary-500 bg-primary-500/10"
              : "cursor-pointer border-white/20 hover:border-white/30 bg-white/5"
        }`}
      >
        <Upload className="size-10 text-slate-500 mx-auto mb-3" />
        <p className="text-slate-300 font-medium">
          {items.length >= MAX_FILE_COUNT
            ? `Maximum ${MAX_FILE_COUNT} files reached`
            : <>
                <span className="hidden sm:inline">Drop receipt images here or click to select</span>
                <span className="sm:hidden">Tap to select from gallery</span>
              </>}
        </p>
        <p className="text-sm text-slate-500 mt-1">
          JPEG, PNG, or WEBP up to 10MB &middot; Up to {MAX_FILE_COUNT} files per batch
        </p>
        <input
          ref={inputRef}
          type="file"
          multiple
          accept="image/jpeg,image/png,image/webp"
          className="hidden"
          disabled={overlayOpen}
          onChange={(e) => {
            const files = Array.from(e.target.files ?? []);
            if (files.length > 0) addFiles(files);
            e.target.value = "";
          }}
        />
      </div>

      {hasItems && (
        <div className="flex items-center justify-between text-sm text-slate-400 px-1">
          <span>
            {items.length} file{items.length === 1 ? "" : "s"} selected
          </span>
          <span>{formatSize(totalSize)}</span>
        </div>
      )}

      {hasItems && (
        <ul className="space-y-2">
          {items.map((item) => (
            <li key={item.id}>
              <Card className="rounded-xl p-3 flex items-center gap-3">
                <img
                  src={item.preview}
                  alt=""
                  className="w-12 h-12 rounded-lg object-cover bg-black/20 flex-shrink-0"
                />
                <div className="flex-1 min-w-0">
                  <p className="text-sm text-slate-200 truncate">
                    {item.file.name}
                  </p>
                  <p className="text-xs text-slate-500">
                    {formatSize(item.file.size)}
                  </p>
                </div>
                {!overlayOpen && (
                  <button
                    onClick={() => removeItem(item.id)}
                    aria-label={`Remove ${item.file.name}`}
                    className="text-slate-500 hover:text-slate-300 cursor-pointer"
                  >
                    <X className="size-4" />
                  </button>
                )}
              </Card>
            </li>
          ))}
        </ul>
      )}

      <div className="flex flex-wrap gap-3">
        <Button
          onClick={handleSubmit}
          disabled={!canSubmit}
          className="flex-1 min-w-[10rem]"
        >
          {pendingCount > 0
            ? `Upload ${pendingCount} file${pendingCount === 1 ? "" : "s"}`
            : "Upload"}
        </Button>
      </div>

      {overlayOpen && (
        <UploadProcessingOverlay
          open={overlayOpen}
          items={overlayItems}
          onComplete={handleOverlayComplete}
          onError={handleOverlayError}
        />
      )}
    </div>
  );
}
