"use client";

import { useEffect, useState } from "react";
import {
  CheckCircle2, ExternalLink, Eye, EyeOff, KeyRound, Loader2, LogOut, ShieldAlert, X,
} from "lucide-react";

export interface SessionStatus {
  authenticated: boolean;
  source: "database" | "environment" | "none";
  userName?: string | null;
  email?: string | null;
  userId?: string | null;
  broker?: string | null;
  tokenMask?: string;
  expiresAt?: string;
  expiresInMinutes?: number;
  expired?: boolean;
  passcodeRequired: boolean;
  message: string;
}

export function sessionTone(s: SessionStatus | null): { label: string; color: string } {
  if (!s) return { label: "…", color: "#6b7280" };
  if (s.authenticated && s.source === "environment") return { label: "ENV TOKEN", color: "#41c8ff" };
  if (s.authenticated) {
    const mins = s.expiresInMinutes ?? 0;
    if (mins < 60) return { label: "EXPIRING", color: "#f5b53f" };
    return { label: s.userName ? s.userName.split(" ")[0].toUpperCase().slice(0, 10) : "SIGNED IN", color: "#2fd47b" };
  }
  if (s.expired) return { label: "EXPIRED", color: "#f0506e" };
  return { label: "SIGN IN", color: "#7d8ca3" };
}

export function expiryText(s: SessionStatus | null): string | null {
  if (!s?.expiresAt || !s.authenticated) return null;
  const mins = s.expiresInMinutes ?? 0;
  if (mins <= 0) return "expired";
  const h = Math.floor(mins / 60);
  return h >= 1 ? `${h}h ${mins % 60}m left` : `${mins}m left`;
}

interface Props {
  open: boolean;
  status: SessionStatus | null;
  onClose: () => void;
  onChanged: (s: SessionStatus) => void;
}

export function LoginModal({ open, status, onClose, onChanged }: Props) {
  const [token, setToken] = useState("");
  const [passcode, setPasscode] = useState("");
  const [show, setShow] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [okMsg, setOkMsg] = useState<string | null>(null);

  useEffect(() => {
    if (open) { setError(null); setOkMsg(null); setToken(""); }
  }, [open]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    if (open) window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;

  const submit = async () => {
    setBusy(true); setError(null); setOkMsg(null);
    try {
      const res = await fetch("/api/v1/auth/upstox", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ accessToken: token, passcode: passcode || undefined }),
      });
      const json = await res.json();
      if (!res.ok || json.error) setError(json.error ?? "Sign-in failed.");
      else {
        onChanged(json as SessionStatus);
        setOkMsg(`Signed in${json.userName ? ` as ${json.userName}` : ""}. Options positioning is now active.`);
        setToken("");
        setTimeout(onClose, 1100);
      }
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const signOut = async () => {
    setBusy(true); setError(null);
    try {
      const res = await fetch(`/api/v1/auth/upstox${passcode ? `?passcode=${encodeURIComponent(passcode)}` : ""}`, {
        method: "DELETE",
      });
      const json = await res.json();
      if (!res.ok || json.error) setError(json.error ?? "Sign-out failed.");
      else { onChanged(json as SessionStatus); setOkMsg("Signed out. Stored token removed."); }
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto p-3 sm:items-center">
      <div className="absolute inset-0 bg-black/70 backdrop-blur-sm" onClick={onClose} />
      <div className="panel rise-in relative my-auto w-full max-w-[430px] p-4 sm:p-5">
        <button
          onClick={onClose}
          className="absolute right-3 top-3 rounded-md border border-[rgba(125,165,220,0.18)] p-1 text-[#8ea3c4] transition hover:text-white"
          aria-label="Close"
        >
          <X className="h-4 w-4" />
        </button>

        <div className="flex items-center gap-2.5">
          <div className="flex h-8 w-8 items-center justify-center rounded-md bg-gradient-to-br from-[#41c8ff] to-[#1d7fb0]">
            <KeyRound className="h-4 w-4 text-[#03131c]" />
          </div>
          <div>
            <h2 className="text-[14px] font-extrabold tracking-[0.1em] text-white">UPSTOX SIGN-IN</h2>
            <p className="mono text-[9px] tracking-[0.1em] text-[#4a586e]">DAILY ACCESS TOKEN · EXPIRES 03:30 IST</p>
          </div>
        </div>

        {/* current state */}
        <div
          className="mono mt-3 rounded-lg border p-2.5 text-[10px] leading-snug"
          style={{
            borderColor: status?.authenticated ? "rgba(47,212,123,0.35)" : "rgba(125,165,220,0.16)",
            background: status?.authenticated ? "rgba(47,212,123,0.06)" : "transparent",
          }}
        >
          <div className="flex items-center gap-1.5">
            {status?.authenticated
              ? <CheckCircle2 className="h-3.5 w-3.5 shrink-0 text-[#2fd47b]" />
              : <ShieldAlert className="h-3.5 w-3.5 shrink-0 text-[#f5b53f]" />}
            <span style={{ color: status?.authenticated ? "#2fd47b" : "#c9a45c" }}>
              {status?.authenticated ? "ACTIVE SESSION" : "NOT SIGNED IN"}
            </span>
            {status?.tokenMask && <span className="text-[#54637a]">· {status.tokenMask}</span>}
          </div>
          <p className="mt-1 text-[#8ea3c4]">{status?.message}</p>
          {status?.authenticated && status.source === "database" && (
            <p className="mt-1 text-[#54637a]">
              {status.userName ?? "user"}{status.email ? ` · ${status.email}` : ""}
              {expiryText(status) ? ` · ${expiryText(status)}` : ""}
            </p>
          )}
        </div>

        {/* token field */}
        <label className="panel-title mt-3 block">ACCESS TOKEN</label>
        <div className="mt-1 flex items-center gap-2 rounded-md border border-[rgba(125,165,220,0.18)] bg-[rgba(4,7,12,0.65)] px-2.5 py-2">
          <input
            type={show ? "text" : "password"}
            value={token}
            onChange={(e) => setToken(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter" && token.trim() && !busy) void submit(); }}
            placeholder="paste today's Upstox access token"
            autoComplete="off"
            spellCheck={false}
            className="mono w-full bg-transparent text-[11.5px] text-[#dce6f2] outline-none placeholder:text-[#4a586e]"
          />
          <button onClick={() => setShow((v) => !v)} className="shrink-0 text-[#4a586e] transition hover:text-[#8ea3c4]" aria-label="Toggle visibility">
            {show ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
          </button>
        </div>

        {status?.passcodeRequired && (
          <>
            <label className="panel-title mt-3 block">ADMIN PASSCODE</label>
            <input
              type="password"
              value={passcode}
              onChange={(e) => setPasscode(e.target.value)}
              placeholder="FMPI_ADMIN_PASSCODE"
              className="mono mt-1 w-full rounded-md border border-[rgba(125,165,220,0.18)] bg-[rgba(4,7,12,0.65)] px-2.5 py-2 text-[11.5px] text-[#dce6f2] outline-none placeholder:text-[#4a586e]"
            />
          </>
        )}

        {error && (
          <p className="mt-2.5 rounded-md border border-[rgba(240,80,110,0.4)] bg-[rgba(240,80,110,0.08)] p-2 text-[10.5px] leading-snug text-[#f9a8bd]">
            {error}
          </p>
        )}
        {okMsg && (
          <p className="mt-2.5 rounded-md border border-[rgba(47,212,123,0.4)] bg-[rgba(47,212,123,0.08)] p-2 text-[10.5px] leading-snug text-[#86efac]">
            {okMsg}
          </p>
        )}

        <div className="mt-3 flex items-center gap-2">
          <button
            onClick={() => void submit()}
            disabled={busy || !token.trim()}
            className="flex flex-1 items-center justify-center gap-2 rounded-md border border-[rgba(65,200,255,0.45)] bg-[rgba(65,200,255,0.12)] py-2 text-[11px] font-bold tracking-[0.1em] text-[#41c8ff] transition hover:bg-[rgba(65,200,255,0.2)] disabled:opacity-40"
          >
            {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <KeyRound className="h-3.5 w-3.5" />}
            {busy ? "VERIFYING…" : "VERIFY & SAVE"}
          </button>
          {status?.source === "database" && (
            <button
              onClick={() => void signOut()}
              disabled={busy}
              className="flex items-center justify-center gap-1.5 rounded-md border border-[rgba(240,80,110,0.35)] px-3 py-2 text-[11px] font-bold tracking-[0.1em] text-[#f0506e] transition hover:bg-[rgba(240,80,110,0.1)] disabled:opacity-40"
            >
              <LogOut className="h-3.5 w-3.5" /> SIGN OUT
            </button>
          )}
        </div>

        <div className="mono mt-3 space-y-1 border-t border-[rgba(125,165,220,0.1)] pt-2.5 text-[9px] leading-relaxed text-[#54637a]">
          <p>
            The token is verified against the live Upstox profile endpoint before it is stored — an invalid token is
            rejected and never saved. It is kept server-side and never returned to the browser.
          </p>
          <p>
            <span className="text-[#8ea3c4]">Not required for analysis.</span> Candles, futures OI and options
            open interest are all reconstructed from public Upstox data. A token only unlocks account-scoped
            endpoints (profile, live quotes, orders).
          </p>
          <a
            href="https://upstox.com/developer/api-documentation/authentication"
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-1 text-[#41c8ff] hover:underline"
          >
            How to generate a daily access token <ExternalLink className="h-2.5 w-2.5" />
          </a>
        </div>
      </div>
    </div>
  );
}
