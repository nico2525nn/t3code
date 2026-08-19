import { useEffect, useState } from "react";

import { useT3ConnectAuth } from "../../cloud/connectAuth";
import { isElectron } from "../../env";
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

/**
 * Opens T3 Connect sign-in. On the web this is Clerk's modal; on desktop the
 * system browser handles the whole flow, so `authPrompt` renders a small
 * waiting dialog that closes itself once the environment server reports the
 * session.
 */
export function useT3ConnectAuthPrompt() {
  const auth = useT3ConnectAuth();
  const [promptOpen, setPromptOpen] = useState(false);

  useEffect(() => {
    if (auth.isSignedIn) {
      setPromptOpen(false);
    }
  }, [auth.isSignedIn]);

  const openAuthPrompt = () => {
    auth.signIn();
    if (isElectron) {
      setPromptOpen(true);
    }
  };

  const authPrompt = isElectron ? (
    <Dialog open={promptOpen} onOpenChange={setPromptOpen}>
      <DialogPopup className="max-w-md">
        <DialogHeader>
          <DialogTitle>Sign in to T3 Connect</DialogTitle>
          <DialogDescription>Finish signing in in your browser.</DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <p className="text-sm text-muted-foreground">
            This window updates on its own when you are done.
            {auth.authorizationUrl ? (
              <>
                {" "}
                Nothing opened?{" "}
                <a
                  className="text-foreground underline underline-offset-2"
                  href={auth.authorizationUrl}
                  rel="noreferrer"
                  target="_blank"
                >
                  Open the sign-in page
                </a>
                .
              </>
            ) : null}
          </p>
        </DialogPanel>
        <DialogFooter>
          <Button variant="ghost" onClick={() => setPromptOpen(false)}>
            Cancel
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  ) : null;

  return { authPrompt, openAuthPrompt };
}
