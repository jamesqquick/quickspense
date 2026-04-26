import { Button } from "@/components/ui/button";
import { ChevronLeft, ChevronRight } from "lucide-react";

type PaginationProps = {
  total: number;
  limit: number;
  offset: number;
  onPageChange: (offset: number) => void;
};

export function Pagination({ total, limit, offset, onPageChange }: PaginationProps) {
  const currentPage = Math.floor(offset / limit) + 1;
  const totalPages = Math.max(1, Math.ceil(total / limit));
  const hasPrev = offset > 0;
  const hasNext = offset + limit < total;

  if (totalPages <= 1) return null;

  return (
    <div className="flex items-center justify-between pt-4">
      <p className="text-sm text-slate-500">
        {total === 0
          ? "No results"
          : `${offset + 1}\u2013${Math.min(offset + limit, total)} of ${total}`}
      </p>
      <div className="flex items-center gap-2">
        <Button
          variant="outline"
          size="sm"
          disabled={!hasPrev}
          onClick={() => onPageChange(Math.max(0, offset - limit))}
        >
          <ChevronLeft className="size-4" />
          <span className="sr-only sm:not-sr-only">Prev</span>
        </Button>
        <span className="text-sm text-slate-400 min-w-[5ch] text-center">
          {currentPage} / {totalPages}
        </span>
        <Button
          variant="outline"
          size="sm"
          disabled={!hasNext}
          onClick={() => onPageChange(offset + limit)}
        >
          <span className="sr-only sm:not-sr-only">Next</span>
          <ChevronRight className="size-4" />
        </Button>
      </div>
    </div>
  );
}
