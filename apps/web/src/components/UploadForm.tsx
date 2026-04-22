import { useState, useRef, useCallback } from "react";

export function UploadForm() {
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const handleFile = useCallback((f: File) => {
    const allowed = ["image/jpeg", "image/png", "image/webp"];
    if (!allowed.includes(f.type)) {
      setError("File must be JPEG, PNG, or WEBP");
      return;
    }
    if (f.size > 10 * 1024 * 1024) {
      setError("File must be under 10MB");
      return;
    }
    setError(null);
    setFile(f);
    setPreview(URL.createObjectURL(f));
  }, []);

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      setDragOver(false);
      const f = e.dataTransfer.files[0];
      if (f) handleFile(f);
    },
    [handleFile],
  );

  const handleSubmit = async () => {
    if (!file) return;
    setUploading(true);
    setError(null);

    const form = new FormData();
    form.append("file", file);

    try {
      const res = await fetch("/api/receipts", { method: "POST", body: form });
      if (res.ok) {
        window.location.href = "/receipts";
      } else {
        const data = await res.json();
        setError(data.error || "Upload failed");
      }
    } catch {
      setError("Upload failed");
    } finally {
      setUploading(false);
    }
  };

  return (
    <div className="space-y-4">
      <div
        onDragOver={(e) => {
          e.preventDefault();
          setDragOver(true);
        }}
        onDragLeave={() => setDragOver(false)}
        onDrop={handleDrop}
        onClick={() => inputRef.current?.click()}
        className={`border-2 border-dashed rounded-2xl p-12 text-center cursor-pointer transition-colors duration-200 ${
          dragOver
            ? "border-primary-500 bg-primary-500/10"
            : "border-white/20 hover:border-white/30 bg-white/5"
        }`}
      >
        {preview ? (
          <img
            src={preview}
            alt="Receipt preview"
            className="max-h-64 mx-auto rounded-xl"
          />
        ) : (
          <div>
            <svg className="w-10 h-10 text-slate-500 mx-auto mb-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-8l-4-4m0 0L8 8m4-4v12" />
            </svg>
            <p className="text-slate-300 font-medium">
              Drop a receipt image here or click to select
            </p>
            <p className="text-sm text-slate-500 mt-1">
              JPEG, PNG, or WEBP up to 10MB
            </p>
          </div>
        )}
        <input
          ref={inputRef}
          type="file"
          accept="image/jpeg,image/png,image/webp"
          className="hidden"
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) handleFile(f);
          }}
        />
      </div>

      {file && (
        <div className="flex items-center justify-between glass rounded-xl p-3">
          <span className="text-sm text-slate-300 truncate">{file.name}</span>
          <span className="text-sm text-slate-500">
            {(file.size / 1024).toFixed(0)} KB
          </span>
        </div>
      )}

      {error && <p className="text-red-400 text-sm">{error}</p>}

      <button
        onClick={handleSubmit}
        disabled={!file || uploading}
        className="w-full bg-accent-500 text-white py-2.5 px-4 rounded-xl hover:bg-accent-600 font-semibold transition-colors duration-200 disabled:opacity-50 disabled:cursor-not-allowed cursor-pointer"
      >
        {uploading ? "Uploading..." : "Upload Receipt"}
      </button>
    </div>
  );
}
