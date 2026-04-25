import { useState, useRef, useCallback } from "react";

const ALLOWED_TYPES = ["image/jpeg", "image/png", "image/webp"];
const MAX_FILE_SIZE = 10 * 1024 * 1024;
const MAX_FILE_COUNT = 10;

// Camera icon SVG for the Take Photo button
function CameraIcon({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      fill="none"
      stroke="currentColor"
      viewBox="0 0 24 24"
    >
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth={1.5}
        d="M6.827 6.175A2.31 2.31 0 015.186 7.23c-.38.054-.757.112-1.134.175C2.999 7.58 2.25 8.507 2.25 9.574V18a2.25 2.25 0 002.25 2.25h15A2.25 2.25 0 0021.75 18V9.574c0-1.067-.75-1.994-1.802-2.169a47.865 47.865 0 00-1.134-.175 2.31 2.31 0 01-1.64-1.055l-.822-1.316a2.192 2.192 0 00-1.736-1.039 48.774 48.774 0 00-5.232 0 2.192 2.192 0 00-1.736 1.039l-.821 1.316z"
      />
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth={1.5}
        d="M16.5 12.75a4.5 4.5 0 11-9 0 4.5 4.5 0 019 0z"
      />
    </svg>
  );
}

type UploadStatus = "pending" | "uploading" | "success" | "failed";

type FileItem = {
  id: string;
  file: File;
  preview: string;
  status: UploadStatus;
  error?: string;
};

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
  const [error, setError] = useState<string | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const [isUploading, setIsUploading] = useState(false);
  const [batchComplete, setBatchComplete] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const cameraRef = useRef<HTMLInputElement>(null);

  const addFiles = useCallback(
    (files: File[]) => {
      if (isUploading) return;
      setError(null);
      setBatchComplete(false);

      setItems((prev) => {
        const remainingSlots = MAX_FILE_COUNT - prev.length;
        if (remainingSlots <= 0) {
          setError(`Maximum ${MAX_FILE_COUNT} files allowed`);
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
          setError(rejections.join("; "));
        }

        return [...prev, ...accepted];
      });
    },
    [isUploading],
  );

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      setDragOver(false);
      if (isUploading) return;
      const files = Array.from(e.dataTransfer.files);
      if (files.length > 0) addFiles(files);
    },
    [addFiles, isUploading],
  );

  const removeItem = useCallback(
    (id: string) => {
      if (isUploading) return;
      setItems((prev) => {
        const target = prev.find((i) => i.id === id);
        if (target) URL.revokeObjectURL(target.preview);
        return prev.filter((i) => i.id !== id);
      });
    },
    [isUploading],
  );

  const uploadOne = useCallback(async (item: FileItem): Promise<boolean> => {
    const form = new FormData();
    form.append("file", item.file);

    try {
      const res = await fetch("/api/receipts", { method: "POST", body: form });
      if (res.ok) {
        setItems((prev) =>
          prev.map((i) => (i.id === item.id ? { ...i, status: "success" } : i)),
        );
        return true;
      }
      const data = await res.json().catch(() => ({}));
      setItems((prev) =>
        prev.map((i) =>
          i.id === item.id
            ? { ...i, status: "failed", error: data.error || "Upload failed" }
            : i,
        ),
      );
      return false;
    } catch {
      setItems((prev) =>
        prev.map((i) =>
          i.id === item.id
            ? { ...i, status: "failed", error: "Upload failed" }
            : i,
        ),
      );
      return false;
    }
  }, []);

  const handleSubmit = async () => {
    const pending = items.filter((i) => i.status === "pending");
    if (pending.length === 0) return;

    setIsUploading(true);
    setError(null);
    setBatchComplete(false);

    // Mark all pending as uploading visually one-at-a-time as we go
    for (const item of pending) {
      setItems((prev) =>
        prev.map((i) => (i.id === item.id ? { ...i, status: "uploading" } : i)),
      );
      await uploadOne(item);
    }

    setIsUploading(false);
    setBatchComplete(true);
  };

  const handleRetry = async (id: string) => {
    if (isUploading) return;
    const target = items.find((i) => i.id === id);
    if (!target || target.status !== "failed") return;

    setIsUploading(true);
    setError(null);
    setItems((prev) =>
      prev.map((i) =>
        i.id === id ? { ...i, status: "uploading", error: undefined } : i,
      ),
    );
    await uploadOne(target);
    setIsUploading(false);
  };

  const totalSize = items.reduce((sum, i) => sum + i.file.size, 0);
  const successCount = items.filter((i) => i.status === "success").length;
  const failedCount = items.filter((i) => i.status === "failed").length;
  const pendingCount = items.filter((i) => i.status === "pending").length;
  const hasItems = items.length > 0;
  const canSubmit = !isUploading && pendingCount > 0;
  const allSettled =
    hasItems && items.every((i) => i.status === "success" || i.status === "failed");

  const canAddFiles = !isUploading && items.length < MAX_FILE_COUNT;

  return (
    <div className="space-y-4">
      {/* Mobile: Take Photo button */}
      <button
        type="button"
        onClick={() => {
          if (canAddFiles) cameraRef.current?.click();
        }}
        disabled={!canAddFiles}
        className="sm:hidden w-full flex items-center justify-center gap-3 bg-accent-500 text-white px-6 py-4 rounded-2xl hover:bg-accent-600 font-semibold transition-colors duration-200 disabled:opacity-50 disabled:cursor-not-allowed cursor-pointer"
      >
        <CameraIcon className="w-6 h-6" />
        Take Photo
      </button>
      <input
        ref={cameraRef}
        type="file"
        accept="image/*"
        capture="environment"
        className="hidden"
        disabled={isUploading}
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
          if (!isUploading) setDragOver(true);
        }}
        onDragLeave={() => setDragOver(false)}
        onDrop={handleDrop}
        onClick={() => {
          if (canAddFiles) inputRef.current?.click();
        }}
        className={`border-2 border-dashed rounded-2xl p-6 sm:p-12 text-center transition-colors duration-200 ${
          isUploading || items.length >= MAX_FILE_COUNT
            ? "cursor-not-allowed opacity-60 border-white/20 bg-white/5"
            : dragOver
              ? "cursor-pointer border-primary-500 bg-primary-500/10"
              : "cursor-pointer border-white/20 hover:border-white/30 bg-white/5"
        }`}
      >
        <svg
          className="w-10 h-10 text-slate-500 mx-auto mb-3"
          fill="none"
          stroke="currentColor"
          viewBox="0 0 24 24"
        >
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth={1.5}
            d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-8l-4-4m0 0L8 8m4-4v12"
          />
        </svg>
        <p className="text-slate-300 font-medium">
          {isUploading
            ? "Uploading in progress..."
            : items.length >= MAX_FILE_COUNT
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
          disabled={isUploading}
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
            <li
              key={item.id}
              className="flex items-center gap-3 glass rounded-xl p-3"
            >
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
                  {item.status === "failed" && item.error && (
                    <span className="text-red-400"> &middot; {item.error}</span>
                  )}
                </p>
              </div>
              <StatusBadge status={item.status} />
              {item.status === "failed" && !isUploading && (
                <button
                  onClick={() => handleRetry(item.id)}
                  className="text-xs text-accent-400 hover:text-accent-300 font-semibold px-2 py-1 rounded cursor-pointer"
                >
                  Retry
                </button>
              )}
              {!isUploading && item.status !== "success" && (
                <button
                  onClick={() => removeItem(item.id)}
                  aria-label={`Remove ${item.file.name}`}
                  className="text-slate-500 hover:text-slate-300 cursor-pointer"
                >
                  <svg
                    className="w-4 h-4"
                    fill="none"
                    stroke="currentColor"
                    viewBox="0 0 24 24"
                  >
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      strokeWidth={2}
                      d="M6 18L18 6M6 6l12 12"
                    />
                  </svg>
                </button>
              )}
            </li>
          ))}
        </ul>
      )}

      {error && <p className="text-red-400 text-sm">{error}</p>}

      {batchComplete && allSettled && (
        <div className="glass rounded-xl p-3 text-sm">
          <p className="text-slate-200">
            {successCount} of {items.length} uploaded successfully
            {failedCount > 0 && (
              <span className="text-red-400">
                {" "}
                &middot; {failedCount} failed
              </span>
            )}
          </p>
        </div>
      )}

      <div className="flex gap-3">
        <button
          onClick={handleSubmit}
          disabled={!canSubmit}
          className="flex-1 bg-accent-500 text-white py-2.5 px-4 rounded-xl hover:bg-accent-600 font-semibold transition-colors duration-200 disabled:opacity-50 disabled:cursor-not-allowed cursor-pointer"
        >
          {isUploading
            ? "Uploading..."
            : pendingCount > 0
              ? `Upload ${pendingCount} file${pendingCount === 1 ? "" : "s"}`
              : "Upload"}
        </button>
        {batchComplete && successCount > 0 && (
          <a
            href="/receipts"
            className="flex-1 bg-primary-500 text-white py-2.5 px-4 rounded-xl hover:bg-primary-600 font-semibold transition-colors duration-200 text-center cursor-pointer"
          >
            View Receipts
          </a>
        )}
      </div>
    </div>
  );
}

function StatusBadge({ status }: { status: UploadStatus }) {
  if (status === "pending") {
    return <span className="text-xs text-slate-500">Pending</span>;
  }
  if (status === "uploading") {
    return (
      <svg
        className="w-4 h-4 text-accent-400 animate-spin"
        fill="none"
        viewBox="0 0 24 24"
      >
        <circle
          className="opacity-25"
          cx="12"
          cy="12"
          r="10"
          stroke="currentColor"
          strokeWidth="4"
        />
        <path
          className="opacity-75"
          fill="currentColor"
          d="M4 12a8 8 0 018-8v4a4 4 0 00-4 4H4z"
        />
      </svg>
    );
  }
  if (status === "success") {
    return (
      <svg
        className="w-5 h-5 text-green-400"
        fill="none"
        stroke="currentColor"
        viewBox="0 0 24 24"
      >
        <path
          strokeLinecap="round"
          strokeLinejoin="round"
          strokeWidth={2}
          d="M5 13l4 4L19 7"
        />
      </svg>
    );
  }
  return (
    <svg
      className="w-5 h-5 text-red-400"
      fill="none"
      stroke="currentColor"
      viewBox="0 0 24 24"
    >
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth={2}
        d="M12 9v2m0 4h.01M5.07 19h13.86a2 2 0 001.74-3L13.74 4a2 2 0 00-3.48 0L3.34 16a2 2 0 001.73 3z"
      />
    </svg>
  );
}
