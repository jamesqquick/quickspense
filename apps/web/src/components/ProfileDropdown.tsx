import { LogOut } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
} from "@/components/ui/dropdown-menu";

function getInitials(email: string): string {
  const local = email.split("@")[0] ?? "";
  // Try splitting on dots or common separators to get first/last initials
  const parts = local.split(/[._-]/).filter(Boolean);
  if (parts.length >= 2) {
    return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
  }
  return local.slice(0, 2).toUpperCase();
}

export function ProfileDropdown({ email }: { email: string }) {
  const initials = getInitials(email);

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          className="flex size-9 items-center justify-center rounded-full border-2 border-accent-500 bg-accent-500/20 text-sm font-semibold text-accent-400 transition-colors duration-200 hover:bg-accent-500/30 focus:outline-none cursor-pointer"
          aria-label="Profile menu"
        >
          {initials}
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-56">
        <DropdownMenuLabel className="font-normal">
          <p className="text-sm font-medium text-white truncate">{email}</p>
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        <DropdownMenuItem
          onSelect={() => {
            document.getElementById("profile-logout-form")?.requestSubmit();
          }}
          className="text-red-400 focus:text-red-300"
        >
          <LogOut className="size-4" />
          Log out
        </DropdownMenuItem>
      </DropdownMenuContent>
      {/* Hidden form for logout POST */}
      <form
        id="profile-logout-form"
        method="POST"
        action="/api/auth/logout"
        className="hidden"
      />
    </DropdownMenu>
  );
}
