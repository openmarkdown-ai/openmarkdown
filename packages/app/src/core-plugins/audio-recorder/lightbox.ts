/**
 * The full-screen image viewer (Obsidian 1.13): the clicked image, its file
 * name, arrow keys through every image of the same note, drag to pan, wheel
 * or +/- to zoom, 0 to reset, Escape or a click on the backdrop to close.
 */
import { setIcon } from "../../obsidian/ui/icons";
import { Scope, keymapFor } from "../../obsidian/ui/keymap";

export interface LightboxImage {
  src: string;
  name: string;
}

/** The images of the rendered note that contains `img`, and the index of `img` among them. */
export function collectImages(img: HTMLImageElement): { images: LightboxImage[]; index: number } {
  const root = img.closest<HTMLElement>(".markdown-rendered, .markdown-preview-view, .markdown-source-view, .view-content");
  const els = root ? Array.from(root.querySelectorAll<HTMLImageElement>(".image-embed img")) : [img];
  if (!els.includes(img)) els.unshift(img);
  const images = els.map((el) => ({ src: el.currentSrc || el.src, name: imageName(el) }));
  return { images, index: els.indexOf(img) };
}

function imageName(el: HTMLImageElement): string {
  const embed = el.closest<HTMLElement>(".internal-embed");
  const src = embed?.getAttr("src") ?? el.getAttr("data-name") ?? el.alt ?? "";
  const path = src.split("#")[0] ?? "";
  return path.slice(path.lastIndexOf("/") + 1) || el.alt || "";
}

export function openLightbox(app: any, images: LightboxImage[], start: number): void {
  if (images.length === 0) return;
  let index = Math.max(0, Math.min(start, images.length - 1));
  let scale = 1;
  let tx = 0;
  let ty = 0;

  const doc = (globalThis as { activeDocument?: Document }).activeDocument ?? document;
  const containerEl = doc.body.createDiv({ cls: "vault-lightbox" });
  containerEl.setAttr("role", "dialog");
  containerEl.setAttr("aria-modal", "true");
  containerEl.setAttr("tabindex", "-1");
  const stageEl = containerEl.createDiv({ cls: "vault-lightbox-stage" });
  const imgEl = stageEl.createEl("img", { cls: "vault-lightbox-image", attr: { draggable: "false" } });
  const captionEl = containerEl.createDiv({ cls: "vault-lightbox-caption" });
  const closeEl = containerEl.createDiv({ cls: "vault-lightbox-close clickable-icon", attr: { "aria-label": "Close", role: "button" } });
  setIcon(closeEl, "lucide-x");
  const prevEl = containerEl.createDiv({ cls: "vault-lightbox-nav mod-prev clickable-icon", attr: { "aria-label": "Previous image", role: "button" } });
  setIcon(prevEl, "lucide-chevron-left");
  const nextEl = containerEl.createDiv({ cls: "vault-lightbox-nav mod-next clickable-icon", attr: { "aria-label": "Next image", role: "button" } });
  setIcon(nextEl, "lucide-chevron-right");

  const apply = () => {
    imgEl.style.transform = `translate(${tx}px, ${ty}px) scale(${scale})`;
    containerEl.toggleClass("is-zoomed", scale !== 1);
  };
  const reset = () => {
    scale = 1;
    tx = 0;
    ty = 0;
    apply();
  };
  const show = () => {
    const item = images[index]!;
    imgEl.src = item.src;
    imgEl.alt = item.name;
    captionEl.setText(images.length > 1 ? `${item.name} (${index + 1} / ${images.length})` : item.name);
    prevEl.toggle(images.length > 1);
    nextEl.toggle(images.length > 1);
    reset();
  };
  const go = (delta: number) => {
    if (images.length < 2) return;
    index = (index + delta + images.length) % images.length;
    show();
  };
  const zoom = (factor: number) => {
    scale = Math.min(20, Math.max(0.1, scale * factor));
    apply();
  };

  const scope = new Scope();
  const keymap = keymapFor(app);
  const close = () => {
    keymap.popScope(scope);
    containerEl.remove();
  };
  scope.register([], "Escape", () => (close(), false));
  scope.register([], "ArrowLeft", () => (go(-1), false));
  scope.register([], "ArrowRight", () => (go(1), false));
  scope.register(null, "+", () => (zoom(1.25), false));
  scope.register(null, "=", () => (zoom(1.25), false));
  scope.register(null, "-", () => (zoom(0.8), false));
  scope.register([], "0", () => (reset(), false));
  keymap.pushScope(scope);

  closeEl.addEventListener("click", close);
  prevEl.addEventListener("click", (e) => (e.stopPropagation(), go(-1)));
  nextEl.addEventListener("click", (e) => (e.stopPropagation(), go(1)));

  let drag: { x: number; y: number; tx: number; ty: number; moved: boolean } | null = null;
  let downOnBackdrop = false;
  containerEl.addEventListener("pointerdown", (evt) => {
    if (evt.button !== 0) return;
    if (evt.target === imgEl) {
      drag = { x: evt.clientX, y: evt.clientY, tx, ty, moved: false };
      imgEl.setPointerCapture(evt.pointerId);
      containerEl.addClass("is-panning");
      evt.preventDefault();
    } else downOnBackdrop = evt.target === containerEl || evt.target === stageEl;
  });
  imgEl.addEventListener("pointermove", (evt) => {
    if (!drag) return;
    const dx = evt.clientX - drag.x;
    const dy = evt.clientY - drag.y;
    if (Math.abs(dx) + Math.abs(dy) > 3) drag.moved = true;
    tx = drag.tx + dx;
    ty = drag.ty + dy;
    apply();
  });
  const endDrag = () => {
    drag = null;
    containerEl.removeClass("is-panning");
  };
  imgEl.addEventListener("pointerup", endDrag);
  imgEl.addEventListener("pointercancel", endDrag);
  containerEl.addEventListener("click", (evt) => {
    if (downOnBackdrop && (evt.target === containerEl || evt.target === stageEl)) close();
    downOnBackdrop = false;
  });
  containerEl.addEventListener(
    "wheel",
    (evt) => {
      evt.preventDefault();
      zoom(evt.deltaY < 0 ? 1.1 : 1 / 1.1);
    },
    { passive: false },
  );
  imgEl.addEventListener("dblclick", () => (scale === 1 ? zoom(2) : reset()));

  show();
  containerEl.focus({ preventScroll: true });
}
