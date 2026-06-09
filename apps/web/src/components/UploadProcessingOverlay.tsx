import { Dialog, DialogContent } from "@/components/ui/dialog";
import {
  useUploadProcessing,
  type FileItem,
} from "@/hooks/useUploadProcessing";
import { getUploadStageLabel } from "@/lib/uploadProgress";

export type { FileItem };

type Props = {
  open: boolean;
  items: FileItem[];
  onComplete: (successIds: string[]) => void;
  onError: () => void;
};

export function UploadProcessingOverlay({
  open,
  items,
  onComplete,
  onError,
}: Props) {
  const { stage, detail, progressPercent, indeterminate } = useUploadProcessing({
    active: open,
    items,
    onComplete,
    onError,
  });

  const { title, subtitle } = getUploadStageLabel(stage, detail);
  const showBar = stage.type === "uploading" || stage.type === "processing";

  return (
    <Dialog open={open}>
      <DialogContent
        showClose={false}
        onPointerDownOutside={(e) => e.preventDefault()}
        onEscapeKeyDown={(e) => e.preventDefault()}
        className="max-w-sm text-center"
      >
        <div className="flex flex-col items-center gap-6 py-4">
          <div className="relative w-20 h-20">
            {stage.type === "complete" ? <CompleteIcon /> : <ProcessingIcon />}
          </div>

          <div className="space-y-1">
            <h3 className="text-lg font-semibold text-white">{title}</h3>
            <p className="text-sm text-slate-400">{subtitle}</p>
          </div>

          {showBar && (
            <div className="w-full max-w-xs">
              <div className="w-full bg-white/10 rounded-full h-1.5 overflow-hidden">
                {indeterminate ? (
                  <div className="h-1.5 w-2/5 rounded-full bg-primary-400 animate-indeterminate" />
                ) : (
                  <div
                    className="h-1.5 rounded-full bg-primary-400 transition-all duration-700 ease-out"
                    style={{ width: `${progressPercent}%` }}
                  />
                )}
              </div>
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}

function ProcessingIcon() {
  return (
    <div className="w-20 h-20 relative">
      {/* Spinning dashed circle */}
      <svg
        className="w-20 h-20 animate-spin-slow"
        viewBox="0 0 80 80"
        fill="none"
      >
        <circle
          cx="40"
          cy="40"
          r="35"
          stroke="currentColor"
          strokeWidth="2"
          strokeDasharray="8 6"
          className="text-white/20"
        />
      </svg>
      {/* Floating receipt icon */}
      <div className="absolute inset-0 flex items-center justify-center animate-float">
        <svg
          className="w-8 h-8 text-primary-400"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path d="M4 2v20l2-1 2 1 2-1 2 1 2-1 2 1 2-1 2 1V2l-2 1-2-1-2 1-2-1-2 1-2-1-2 1Z" />
          <path d="M8 7h8" />
          <path d="M8 11h8" />
          <path d="M8 15h4" />
        </svg>
      </div>
    </div>
  );
}

function CompleteIcon() {
  return (
    <div className="w-20 h-20 flex items-center justify-center animate-scale-in">
      <div className="w-16 h-16 rounded-full bg-green-400/20 flex items-center justify-center">
        <svg
          className="w-8 h-8 text-green-400"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2.5"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <polyline points="20 6 9 17 4 12" />
        </svg>
      </div>
    </div>
  );
}
