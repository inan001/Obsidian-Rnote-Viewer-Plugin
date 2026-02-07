import { App, Plugin, TFile, TextFileView, WorkspaceLeaf, Notice } from 'obsidian';
// @ts-ignore
import * as pako from 'pako';

// ------------------------------------------------------------------
// 1. IMPROVED DATA SCHEMA (Strict Adherence)
// ------------------------------------------------------------------

export interface RnoteFile {
    version: string;
    data: {
        engine_snapshot: {
            stroke_components: Component[];
        };
    };
}

export interface Component {
    value: {
        brushstroke?: BrushStroke;
        shapestroke?: ShapeStroke;
        textstroke?: TextStroke;
    } | null;
}

// TYPE A: HANDWRITING
export interface BrushStroke {
    path: {
        start: { pos: Point; pressure?: number }; // Added pressure
        segments: { lineto: { end: { pos: Point; pressure?: number } } }[]; // Added pressure
    };
    style: StyleWrapper;
}

// TYPE B: SHAPES
export interface ShapeStroke {
    shape: {
        // Geometric Primitives
        rect?: { cuboid: { half_extents: Point }; transform?: MatrixWrapper };
        ellipse?: { radii: Point; transform?: MatrixWrapper };
        line?: { start: Point; end: Point };
        arrow?: { start: Point; tip: Point };

        // Curves
        cubbez?: { start: Point; cp1: Point; cp2: Point; end: Point };
        quadbez?: { start: Point; cp: Point; end: Point };

        // Polygons
        poly_line?: { points: Point[] };
        polygon?: { points: Point[] };
    };
    style: StyleWrapper;
}

// TYPE C: TEXT
export interface TextStroke {
    text: string;
    transform: MatrixWrapper;
    text_style: {
        font_size: number;
        color: RnoteColor;
    };
}

// HELPERS
export type Point = [number, number]; // [x, y]

export interface MatrixWrapper {
    affine: [number, number, number, number, number, number, number, number, number];
}

export interface RnoteColor { r: number; g: number; b: number; a: number; }

export interface StyleWrapper {
    smooth?: StrokeStyle;
    rough?: StrokeStyle;
    technic?: StrokeStyle;
}

export interface StrokeStyle {
    stroke_width: number;
    stroke_color: RnoteColor;
}

// ------------------------------------------------------------------
// 2. CONSTANTS & VIEW TYPE
// ------------------------------------------------------------------

export const VIEW_TYPE_RNOTE = "rnote-view";

// ------------------------------------------------------------------
// 3. RNOTE VIEW IMPLEMENTATION
// ------------------------------------------------------------------

export class RnoteView extends TextFileView {
    constructor(leaf: WorkspaceLeaf) {
        super(leaf);
    }

    getViewType() {
        return VIEW_TYPE_RNOTE;
    }

    getDisplayText() {
        return this.file ? this.file.basename : "Rnote Viewer";
    }

    async onLoadFile(file: TFile): Promise<void> {
        this.file = file;
        const buffer = await this.app.vault.readBinary(file);
        await this.renderRnote(buffer);
    }

    getViewData(): string {
        return "";
    }

    setViewData(data: string, clear: boolean): void {
        // Not used
    }

    async renderRnote(buffer: ArrayBuffer) {
        const container = this.contentEl;
        container.empty();

        try {
            // 1. Decompress
            const inflated = pako.ungzip(new Uint8Array(buffer), { to: 'string' });
            const json = JSON.parse(inflated) as RnoteFile;

            // 2. Setup SVG
            const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");

            // Define Arrowhead
            const defs = document.createElementNS("http://www.w3.org/2000/svg", "defs");
            defs.innerHTML = `<marker id="arrowhead" markerWidth="10" markerHeight="7" refX="9" refY="3.5" orient="auto"><polygon points="0 0, 10 3.5, 0 7" fill="context-stroke" /></marker>`;
            svg.appendChild(defs);

            // 3. Helpers
            let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
            function updateBounds(x: number, y: number) {
                if (x < minX) minX = x;
                if (y < minY) minY = y;
                if (x > maxX) maxX = x;
                if (y > maxY) maxY = y;
            }

            function getColor(style: any) {
                const s = style?.smooth || style?.rough || style?.technic;
                if (s && s.stroke_color) {
                    const c = s.stroke_color;
                    return `rgba(${Math.round(c.r * 255)}, ${Math.round(c.g * 255)}, ${Math.round(c.b * 255)}, ${c.a ?? 1})`;
                }
                return "black";
            }

            function getWidth(style: any) {
                const s = style?.smooth || style?.rough || style?.technic;
                return s?.stroke_width ? String(s.stroke_width) : "2";
            }

            // Using User's Mapping from Fix
            function getSvgTransformUser(affine: number[]) {
                return `matrix(${affine[0]},${affine[1]},${affine[3]},${affine[4]},${affine[6]},${affine[7]})`;
            }

            function styleAndAppend(el: SVGElement, source: any) {
                el.setAttribute("fill", "none");
                el.setAttribute("stroke", getColor(source.style));
                el.setAttribute("stroke-width", getWidth(source.style));
                el.setAttribute("stroke-linecap", "round");
                el.setAttribute("stroke-linejoin", "round");
                svg.appendChild(el);
            }

            // Recursive Unwrapper
            function getInnerShape(s: any): any {
                if (!s) return null;
                if (s.shape) return getInnerShape(s.shape);
                return s;
            }

            // Variable Width Path Helper
            function getVariableWidthPath(points: Point[], pressures: number[], baseWidth: number): string {
                if (points.length < 2) return "";

                const leftSide: Point[] = [];
                const rightSide: Point[] = [];

                for (let i = 0; i < points.length; i++) {
                    const curr = points[i];
                    const next = points[i + 1] || points[i];
                    const prev = points[i - 1] || points[i];

                    // Calculate direction vector
                    let dx = next[0] - prev[0];
                    let dy = next[1] - prev[1];

                    // Handle edge cases for start/end
                    if (i === 0) { dx = next[0] - curr[0]; dy = next[1] - curr[1]; }
                    if (i === points.length - 1) { dx = curr[0] - prev[0]; dy = curr[1] - prev[1]; }

                    const len = Math.sqrt(dx * dx + dy * dy) || 1;

                    // Normal vector (perpendicular)
                    const nx = -dy / len;
                    const ny = dx / len;

                    // Calculate thickness at this specific point
                    // Rnote pressure is 0.0-1.0. We multiply by baseWidth / 2 for the radius.
                    const p = pressures[i] !== undefined ? pressures[i] : 0.5;
                    const halfWidth = (baseWidth * p) / 2;

                    leftSide.push([curr[0] + nx * halfWidth, curr[1] + ny * halfWidth]);
                    rightSide.push([curr[0] - nx * halfWidth, curr[1] - ny * halfWidth]);
                }

                // Construct SVG Path: Move down Left side, then up Right side
                let d = `M ${leftSide[0][0]} ${leftSide[0][1]}`;
                for (let i = 1; i < leftSide.length; i++) d += ` L ${leftSide[i][0]} ${leftSide[i][1]}`;
                // Loop back up the right side (in reverse)
                for (let i = rightSide.length - 1; i >= 0; i--) d += ` L ${rightSide[i][0]} ${rightSide[i][1]}`;
                d += " Z"; // Close the loop

                return d;
            }

            // 4. Render Loop
            const components = json.data?.engine_snapshot?.stroke_components || [];

            for (const component of components) {
                if (!component.value) continue;

                // TYPE: HANDWRITING (Updated for Pressure Sensitivity)
                if (component.value.brushstroke) {
                    const b = component.value.brushstroke;

                    // 1. Collect all Points and Pressures
                    const points: Point[] = [];
                    const pressures: number[] = [];

                    // Start Point
                    points.push(b.path.start.pos);
                    // @ts-ignore
                    pressures.push(b.path.start.pressure);
                    updateBounds(b.path.start.pos[0], b.path.start.pos[1]);

                    // Segment Points
                    for (const seg of b.path.segments) {
                        const pt = seg.lineto.end.pos;
                        // @ts-ignore
                        const pr = seg.lineto.end.pressure;
                        points.push(pt);
                        pressures.push(pr);
                        updateBounds(pt[0], pt[1]);
                    }

                    // 2. Get Base Width from Style
                    const baseWidth = parseFloat(getWidth(b.style) || "2") * 2; // Multiply by 2 for visual weight

                    // 3. Generate the "Blob" Path
                    const d = getVariableWidthPath(points, pressures, baseWidth);

                    const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
                    path.setAttribute("d", d);

                    // 4. Style as a FILLED shape (not a stroke)
                    path.setAttribute("fill", getColor(b.style));
                    path.setAttribute("stroke", "none"); // Important: Turn off the outline stroke

                    svg.appendChild(path);
                }

                // TYPE: SHAPES
                else if (component.value.shapestroke) {
                    const ss = component.value.shapestroke;
                    const shape = getInnerShape(ss.shape);

                    if (!shape) continue;

                    // --- LINE ---
                    if (shape.line) {
                        const l = shape.line;
                        updateBounds(l.start[0], l.start[1]);
                        updateBounds(l.end[0], l.end[1]);
                        const line = document.createElementNS("http://www.w3.org/2000/svg", "line");
                        line.setAttribute("x1", String(l.start[0]));
                        line.setAttribute("y1", String(l.start[1]));
                        line.setAttribute("x2", String(l.end[0]));
                        line.setAttribute("y2", String(l.end[1]));
                        styleAndAppend(line, ss);
                    }
                    // --- ARROW ---
                    else if (shape.arrow) {
                        const a = shape.arrow;
                        updateBounds(a.start[0], a.start[1]);
                        updateBounds(a.tip[0], a.tip[1]);
                        const line = document.createElementNS("http://www.w3.org/2000/svg", "line");
                        line.setAttribute("x1", String(a.start[0]));
                        line.setAttribute("y1", String(a.start[1]));
                        line.setAttribute("x2", String(a.tip[0]));
                        line.setAttribute("y2", String(a.tip[1]));
                        line.setAttribute("marker-end", "url(#arrowhead)");
                        styleAndAppend(line, ss);
                    }
                    // --- RECT ---
                    else if (shape.rect && shape.rect.cuboid) {
                        const half = shape.rect.cuboid.half_extents;
                        const rect = document.createElementNS("http://www.w3.org/2000/svg", "rect");
                        rect.setAttribute("x", String(-half[0]));
                        rect.setAttribute("y", String(-half[1]));
                        rect.setAttribute("width", String(half[0] * 2));
                        rect.setAttribute("height", String(half[1] * 2));
                        if (shape.rect.transform) {
                            rect.setAttribute("transform", getSvgTransformUser(shape.rect.transform.affine));
                            // Rough bounds
                            const tx = shape.rect.transform.affine[6];
                            const ty = shape.rect.transform.affine[7];
                            updateBounds(tx - half[0], ty - half[1]);
                            updateBounds(tx + half[0], ty + half[1]);
                        }
                        styleAndAppend(rect, ss);
                    }
                    // --- ELLIPSE ---
                    else if (shape.ellipse && shape.ellipse.radii) {
                        const radii = shape.ellipse.radii;
                        const el = document.createElementNS("http://www.w3.org/2000/svg", "ellipse");
                        el.setAttribute("cx", "0");
                        el.setAttribute("cy", "0");
                        el.setAttribute("rx", String(radii[0]));
                        el.setAttribute("ry", String(radii[1]));
                        if (shape.ellipse.transform) {
                            el.setAttribute("transform", getSvgTransformUser(shape.ellipse.transform.affine));
                            const tx = shape.ellipse.transform.affine[6];
                            const ty = shape.ellipse.transform.affine[7];
                            updateBounds(tx - radii[0], ty - radii[1]);
                            updateBounds(tx + radii[0], ty + radii[1]);
                        }
                        styleAndAppend(el, ss);
                    }
                    // --- CURVES (CUBBEZ/QUADBEZ) ---
                    else if (shape.cubbez) {
                        const c = shape.cubbez;
                        updateBounds(c.start[0], c.start[1]);
                        updateBounds(c.end[0], c.end[1]);
                        const d = `M ${c.start[0]} ${c.start[1]} C ${c.cp1[0]} ${c.cp1[1]}, ${c.cp2[0]} ${c.cp2[1]}, ${c.end[0]} ${c.end[1]}`;
                        const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
                        path.setAttribute("d", d);
                        styleAndAppend(path, ss);
                    }
                    else if (shape.quadbez) {
                        const q = shape.quadbez;
                        updateBounds(q.start[0], q.start[1]);
                        updateBounds(q.end[0], q.end[1]);
                        const d = `M ${q.start[0]} ${q.start[1]} Q ${q.cp[0]} ${q.cp[1]} ${q.end[0]} ${q.end[1]}`;
                        const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
                        path.setAttribute("d", d);
                        styleAndAppend(path, ss);
                    }
                    // --- POLYGONS ---
                    else if (shape.poly_line || shape.polygon) {
                        const poly = shape.poly_line || shape.polygon;
                        if (poly.points) {
                            const pts = poly.points.map((p: any) => {
                                updateBounds(p[0], p[1]);
                                return `${p[0]},${p[1]}`;
                            }).join(" ");
                            const tag = shape.polygon ? "polygon" : "polyline";
                            const el = document.createElementNS("http://www.w3.org/2000/svg", tag);
                            el.setAttribute("points", pts);
                            if (poly.transform) el.setAttribute("transform", getSvgTransformUser(poly.transform.affine));
                            styleAndAppend(el, ss);
                        }
                    }
                }

                // TYPE: TEXT (Top-level sibling)
                else if (component.value.textstroke) {
                    const ts = component.value.textstroke;
                    const content = ts.text || "";
                    const size = ts.text_style?.font_size || 32;

                    const text = document.createElementNS("http://www.w3.org/2000/svg", "text");
                    text.textContent = content;
                    text.setAttribute("font-size", String(size));
                    text.setAttribute("font-family", "sans-serif");

                    // Text color
                    if (ts.text_style?.color) {
                        const c = ts.text_style.color;
                        text.setAttribute("fill", `rgba(${Math.round(c.r * 255)}, ${Math.round(c.g * 255)}, ${Math.round(c.b * 255)}, ${c.a ?? 1})`);
                    } else {
                        text.setAttribute("fill", "black");
                    }

                    if (ts.transform) {
                        text.setAttribute("transform", getSvgTransformUser(ts.transform.affine));
                        const tx = ts.transform.affine[6];
                        const ty = ts.transform.affine[7];
                        updateBounds(tx, ty);
                        updateBounds(tx + (content.length * size * 0.6), ty + size);
                    }
                    svg.appendChild(text);
                }
            }

            // 5. Finalize ViewBox
            const padding = 50;
            if (minX === Infinity) { minX = 0; minY = 0; maxX = 800; maxY = 600; }
            const w = maxX - minX + (padding * 2);
            const h = maxY - minY + (padding * 2);

            svg.setAttribute("viewBox", `${minX - padding} ${minY - padding} ${w} ${h}`);
            svg.style.backgroundColor = "white";
            svg.style.width = "100%";

            container.appendChild(svg);

        } catch (e) {
            console.error("Rnote render error", e);
            container.createEl("div", { text: "Error rendering Rnote file: " + String(e) });
        }
    }
}

// ------------------------------------------------------------------
// 4. PLUGIN CLASS
// ------------------------------------------------------------------

export default class RnotePlugin extends Plugin {
    async onload() {
        this.registerView(
            VIEW_TYPE_RNOTE,
            (leaf) => new RnoteView(leaf)
        );

        this.registerExtensions(["rnote"], VIEW_TYPE_RNOTE);

        this.registerEvent(
            this.app.vault.on('modify', (file) => {
                this.app.workspace.iterateAllLeaves((leaf) => {
                    if (leaf.view instanceof RnoteView && leaf.view.file === file) {
                        leaf.view.onLoadFile(file as TFile);
                    }
                });
            })
        );
    }

    async onunload() { }
}
