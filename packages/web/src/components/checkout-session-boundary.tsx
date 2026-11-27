'use client';
import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { api } from '@/lib/api-client';
import { checkoutSessionBanner } from '@/lib/step-banners';
import { Button } from '@/components/ui';
import { MarkdownView } from '@/components/markdown/markdown-view';

const CheckoutEpoch = createContext<string | null>(null);
export const useCheckoutEpoch = () => useContext(CheckoutEpoch);

interface CheckoutState {
  status: string;
  epoch: string | null;
}

/** A replacement epoch survives a fast rebuild and worker/API restarts. Never remount an
 * interactive surface automatically after it changes: retained buffers need human review. */
export function CheckoutSessionBoundary({ path, children }: { path: string; children: ReactNode }) {
  const [current, setCurrent] = useState<CheckoutState | null>(null);
  const [accepted, setAccepted] = useState<CheckoutState | null>(null);
  const [stopped, setStopped] = useState(false);
  const baseline = useRef<CheckoutState | null>(null);
  const [error, setError] = useState(false);
  useEffect(() => {
    let disposed = false;
    let timer: ReturnType<typeof setTimeout>;
    baseline.current = null;
    const poll = async () => {
      try {
        const next = await api.get<CheckoutState>(`${path}/interactive-status`);
        if (disposed) return;
        setError(false);
        setCurrent(next);
        if (!baseline.current) {
          baseline.current = next;
          if (next.status === 'ready') setAccepted(next);
          else setStopped(true);
        } else if (next.status !== 'ready' || baseline.current.epoch !== next.epoch) {
          setStopped(true);
        }
      } catch {
        if (!disposed) {
          setError(true);
          if (baseline.current) setStopped(true);
        }
      }
      if (!disposed) timer = setTimeout(() => void poll(), 2500);
    };
    void poll();
    return () => {
      disposed = true;
      clearTimeout(timer);
    };
  }, [path]);
  const banner = checkoutSessionBanner(current?.status, stopped);
  if (!current || error)
    return (
      <MarkdownView
        body={
          error ? 'Session status could not be checked. Retrying…' : 'Checking repository session…'
        }
        className="text-sm text-neutral-300"
      />
    );
  if (stopped || current.status !== 'ready')
    return (
      <div className="space-y-3 rounded border border-amber-800 bg-amber-950/30 p-4 text-amber-200">
        <MarkdownView body={banner ?? ''} />
        {current.status === 'ready' && (
          <Button
            onClick={() => {
              baseline.current = current;
              setAccepted(current);
              setStopped(false);
            }}
          >
            Reopen session
          </Button>
        )}
      </div>
    );
  return (
    <CheckoutEpoch.Provider value={accepted?.epoch ?? null}>
      <div className="contents" key={accepted?.epoch ?? 'initial'}>
        {children}
      </div>
    </CheckoutEpoch.Provider>
  );
}
