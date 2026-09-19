/**
 * The bottom of the workspace tree. Kept in its own module with no runtime
 * imports so that `WorkspaceLeaf` (leaf.ts) and the containers (items.ts) can
 * both extend it without an import cycle deciding which class exists first.
 */
import { Events } from "../events";

export function randomId(): string {
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

export interface SerializedItem {
  id: string;
  type: string;
  [key: string]: unknown;
}

export abstract class WorkspaceItem extends Events {
  id = randomId();
  abstract parent: any;
  containerEl!: HTMLElement;
  resizeHandleEl: HTMLElement | null = null;
  /** Flex-grow share inside the parent split, as a percentage. */
  dimension: number | null = null;
  // internal
  workspace: any;
  // internal
  app: any;

  getRoot(): WorkspaceItem {
    let item: WorkspaceItem = this;
    while (item.parent && !(item as { isRootContainer?: boolean }).isRootContainer) item = item.parent;
    return item;
  }

  getContainer(): any {
    let item: any = this;
    while (item && !item.isContainer) item = item.parent;
    return item;
  }

  // internal
  setDimension(dimension: number | null) {
    this.dimension = dimension;
    if (this.containerEl) this.containerEl.style.flexGrow = dimension === null ? "" : String(dimension);
  }

  // internal
  abstract serialize(): SerializedItem;

  // internal
  onResize(): void {}
}
