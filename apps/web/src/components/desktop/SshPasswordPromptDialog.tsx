import type { DesktopSshPasswordPromptRequest } from "@t3tools/contracts";
import { useEffect, useId, useRef, useState } from "react";

import { Button } from "../ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Input } from "../ui/input";

function describeSshTarget(request: DesktopSshPasswordPromptRequest): string {
  return request.username ? `${request.username}@${request.destination}` : request.destination;
}

export function SshPasswordPromptDialog() {
  const [queue, setQueue] = useState<readonly DesktopSshPasswordPromptRequest[]>([]);
  const [password, setPassword] = useState("");
  const [isResponding, setIsResponding] = useState(false);
  const currentRequest = queue[0] ?? null;
  const inputRef = useRef<HTMLInputElement | null>(null);
  const isRespondingRef = useRef(false);
  const formId = useId();

  useEffect(() => {
    const bridge = window.desktopBridge;
    if (!bridge?.onSshPasswordPrompt) {
      return;
    }

    return bridge.onSshPasswordPrompt((request) => {
      setQueue((currentQueue) => [...currentQueue, request]);
    });
  }, []);

  useEffect(() => {
    setPassword("");
    if (!currentRequest) {
      return;
    }

    const frame = window.requestAnimationFrame(() => {
      inputRef.current?.focus();
      inputRef.current?.select();
    });
    return () => {
      window.cancelAnimationFrame(frame);
    };
  }, [currentRequest]);

  const respond = async (nextPassword: string | null) => {
    if (!currentRequest || isRespondingRef.current) {
      return;
    }

    const requestId = currentRequest.requestId;
    isRespondingRef.current = true;
    setIsResponding(true);
    try {
      await window.desktopBridge?.resolveSshPasswordPrompt(requestId, nextPassword);
    } catch (error) {
      console.error("Failed to resolve SSH password prompt.", error);
    } finally {
      setQueue((currentQueue) =>
        currentQueue[0]?.requestId === requestId ? currentQueue.slice(1) : currentQueue,
      );
      setPassword("");
      isRespondingRef.current = false;
      setIsResponding(false);
    }
  };

  const target = currentRequest ? describeSshTarget(currentRequest) : null;

  return (
    <Dialog
      open={currentRequest !== null}
      onOpenChange={(open) => {
        if (!open) {
          void respond(null);
        }
      }}
    >
      <DialogPopup className="max-w-md" showCloseButton={false}>
        <DialogHeader>
          <DialogTitle>SSH Password Required</DialogTitle>
          <DialogDescription>
            T3 needs your SSH password to connect to{" "}
            {target ? <code>{target}</code> : "the remote host"}. The password is passed to the
            local SSH process for this connection attempt and is not saved by T3 Code.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel className="space-y-3" scrollFade={false}>
          <form
            className="space-y-3"
            id={formId}
            onSubmit={(event) => {
              event.preventDefault();
              void respond(password);
            }}
          >
            <div className="space-y-2">
              <p className="text-sm font-medium text-foreground">{currentRequest?.prompt}</p>
              <Input
                ref={inputRef}
                autoComplete="current-password"
                disabled={isResponding}
                name="ssh-password"
                type="password"
                value={password}
                onChange={(event) => setPassword(event.target.value)}
              />
            </div>
            <p className="text-sm text-muted-foreground">
              Use SSH keys to avoid repeated password prompts on new SSH sessions.
            </p>
          </form>
        </DialogPanel>
        <DialogFooter>
          <Button
            disabled={isResponding}
            type="button"
            variant="outline"
            onClick={() => void respond(null)}
          >
            Cancel
          </Button>
          <Button disabled={isResponding} form={formId} type="submit">
            Continue
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
