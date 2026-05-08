import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";

const MCP_URL = "https://quickspense-worker.jamesqquick.workers.dev/mcp";

const MCP_CONFIG = JSON.stringify(
  {
    mcpServers: {
      quickspense: {
        type: "streamableHttp",
        url: MCP_URL,
        headers: {
          Authorization: "Bearer <your-token>",
        },
      },
    },
  },
  null,
  2,
);

const TOOLS = [
  "list_receipts",
  "get_receipt",
  "reprocess_receipt",
  "update_receipt_fields",
  "finalize_receipt",
  "list_expenses",
  "create_expense",
  "update_expense",
  "list_categories",
  "create_category",
];

export function McpConnectionInfo() {
  const copyConfig = async () => {
    try {
      await navigator.clipboard.writeText(MCP_CONFIG);
      toast.success("Copied to clipboard");
    } catch {
      toast.error("Failed to copy");
    }
  };

  return (
    <Card className="space-y-5 rounded-xl p-4">
      <p className="text-sm text-slate-400">
        Use this endpoint with any MCP client that supports streamable HTTP.
        Create an API token above, then replace <code>{"<your-token>"}</code> in
        the configuration with the token value.
      </p>

      <div className="grid gap-3 text-sm sm:grid-cols-2">
        <div>
          <p className="text-xs font-medium uppercase tracking-wide text-slate-500">
            Server URL
          </p>
          <code className="mt-1 block break-all rounded-lg bg-white/10 px-3 py-2 text-white">
            {MCP_URL}
          </code>
        </div>
        <div>
          <p className="text-xs font-medium uppercase tracking-wide text-slate-500">
            Transport
          </p>
          <p className="mt-1 rounded-lg bg-white/10 px-3 py-2 text-white">
            Streamable HTTP
          </p>
        </div>
      </div>

      <div>
        <p className="text-xs font-medium uppercase tracking-wide text-slate-500">
          Authentication
        </p>
        <p className="mt-1 text-sm text-slate-300">
          Send your API token in the <code>Authorization</code> header as{" "}
          <code>Bearer &lt;your-token&gt;</code>.
        </p>
      </div>

      <div className="space-y-2">
        <div className="flex items-center justify-between gap-3">
          <p className="text-xs font-medium uppercase tracking-wide text-slate-500">
            Sample JSON configuration
          </p>
          <Button type="button" variant="outline" size="sm" onClick={copyConfig}>
            Copy
          </Button>
        </div>
        <pre className="overflow-x-auto rounded-xl border border-white/10 bg-black/30 p-3 text-xs text-slate-100">
          <code>{MCP_CONFIG}</code>
        </pre>
      </div>

      <div>
        <p className="text-xs font-medium uppercase tracking-wide text-slate-500">
          Available tools
        </p>
        <div className="mt-2 flex flex-wrap gap-2">
          {TOOLS.map((tool) => (
            <code
              key={tool}
              className="rounded-full bg-white/10 px-2.5 py-1 text-xs text-slate-200"
            >
              {tool}
            </code>
          ))}
        </div>
      </div>
    </Card>
  );
}
