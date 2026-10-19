import type { ConsentCategory, Identity } from "./types";

// Unknown consent only lets analytics through: revenue stays correct without
// sending marketing data the visitor never agreed to.
export function allowed(category: ConsentCategory, identity: Identity | null): boolean {
  return identity?.consent[category] ?? category === "analytics";
}
