// Shared react-markdown options for Hangar's own window: links open in the default browser
// (see links.ts) instead of navigating Hangar away.
import type { AnchorHTMLAttributes } from "react";
import type { Components } from "react-markdown";
import { api, errText } from "./api";
import { externalHref } from "./links";
import { useStore } from "./store";

function ExternalLink({ href, children, ...rest }: AnchorHTMLAttributes<HTMLAnchorElement> & { node?: unknown }) {
  const { node: _node, ...attrs } = rest;
  void _node;
  const target = externalHref(href);
  return (
    <a
      {...attrs}
      href={target ?? undefined}
      title={target ?? href}
      onClick={(e) => {
        e.preventDefault();
        if (target) void api.openUrl(target).catch((err) => useStore.getState().toast(errText(err), "bad"));
      }}
    >
      {children}
    </a>
  );
}

export const mdComponents: Components = { a: ExternalLink };
