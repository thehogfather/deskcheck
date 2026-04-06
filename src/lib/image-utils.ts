import { BoundingBox } from "../types";

/**
 * Crop a viewport screenshot to just an element's bounding box.
 * devicePixelRatio accounts for retina displays where the screenshot
 * pixels are larger than CSS pixels.
 */
export function cropScreenshot(
  dataUrl: string,
  box: BoundingBox,
  dpr: number,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const canvas = document.createElement("canvas");
      const sx = Math.round(box.x * dpr);
      const sy = Math.round(box.y * dpr);
      const sw = Math.round(box.width * dpr);
      const sh = Math.round(box.height * dpr);
      canvas.width = sw;
      canvas.height = sh;
      const ctx = canvas.getContext("2d");
      if (!ctx) return reject(new Error("No canvas context"));
      ctx.drawImage(img, sx, sy, sw, sh, 0, 0, sw, sh);
      resolve(canvas.toDataURL("image/png"));
    };
    img.onerror = reject;
    img.src = dataUrl;
  });
}
