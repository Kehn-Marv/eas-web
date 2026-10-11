#!/usr/bin/env npx tsx
/**
 * Script to convert SVG files to inline React components.
 * This eliminates runtime loading and prevents layout shifts.
 * 
 * Usage: npx tsx scripts/svg-to-tsx.ts
 */

import * as fs from "fs";
import * as path from "path";

const PUBLIC_DIR = path.join(process.cwd(), "public");
const OUTPUT_FILE = path.join(process.cwd(), "app/components/svg-icons.tsx");

// SVGs to convert (relative to public/)
const SVG_FILES = [
  "logo.svg",
  "landing-hero-powered-by.svg",
  "landing-footer-powered-by.svg",
  "landing-bg.svg",
];

// Convert kebab-case to camelCase for React
function toCamelCase(str: string): string {
  return str.replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
}

// Convert filename to component name
function toComponentName(filename: string): string {
  const name = filename
    .replace(".svg", "")
    .split("-")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join("");
  return name + "Svg";
}

// Convert inline style string to React style object
function convertInlineStyle(styleString: string): string {
  const styles = styleString.split(";").filter(Boolean);
  const styleObj: Record<string, string> = {};
  
  for (const style of styles) {
    const [key, value] = style.split(":").map((s) => s.trim());
    if (key && value) {
      // Convert kebab-case to camelCase
      const camelKey = key.replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
      styleObj[camelKey] = value;
    }
  }
  
  return `{{${Object.entries(styleObj)
    .map(([k, v]) => `${k}:"${v}"`)
    .join(",")}}}`;
}

// Convert SVG attributes to React-compatible format
function convertAttributes(svg: string): string {
  // SVG attribute mappings to React
  const attributeMap: Record<string, string> = {
    "clip-path": "clipPath",
    "clip-rule": "clipRule",
    "fill-opacity": "fillOpacity",
    "fill-rule": "fillRule",
    "stroke-dasharray": "strokeDasharray",
    "stroke-dashoffset": "strokeDashoffset",
    "stroke-linecap": "strokeLinecap",
    "stroke-linejoin": "strokeLinejoin",
    "stroke-miterlimit": "strokeMiterlimit",
    "stroke-opacity": "strokeOpacity",
    "stroke-width": "strokeWidth",
    "font-family": "fontFamily",
    "font-size": "fontSize",
    "font-style": "fontStyle",
    "font-weight": "fontWeight",
    "text-anchor": "textAnchor",
    "text-decoration": "textDecoration",
    "dominant-baseline": "dominantBaseline",
    "alignment-baseline": "alignmentBaseline",
    "stop-color": "stopColor",
    "stop-opacity": "stopOpacity",
    "xlink:href": "xlinkHref",
    "xmlns:xlink": "xmlnsXlink",
    class: "className",
  };

  let result = svg;

  // Replace attributes
  for (const [svgAttr, reactAttr] of Object.entries(attributeMap)) {
    // Match attribute with = sign to avoid partial matches
    const regex = new RegExp(`\\b${svgAttr}=`, "g");
    result = result.replace(regex, `${reactAttr}=`);
  }

  // Convert inline style="..." to style={{...}}
  result = result.replace(/style="([^"]+)"/g, (_, styleStr) => {
    return `style=${convertInlineStyle(styleStr)}`;
  });

  // Remove xmlns:xhtml namespace declarations from divs (not needed in React)
  result = result.replace(/ xmlns="http:\/\/www\.w3\.org\/1999\/xhtml"/g, "");

  return result;
}

// Extract the SVG content and make it a React component
function svgToComponent(svgContent: string, componentName: string): string {
  // Convert attributes
  let converted = convertAttributes(svgContent);

  // Remove XML declaration if present
  converted = converted.replace(/<\?xml[^>]*\?>\s*/g, "");

  // Remove comments
  converted = converted.replace(/<!--[\s\S]*?-->/g, "");

  // Add className prop to the SVG element
  converted = converted.replace(
    /<svg([^>]*)>/,
    "<svg$1 className={className} {...props}>"
  );

  // Remove fixed width/height from SVG tag (we'll control via className)
  // But keep viewBox for proper scaling
  converted = converted.replace(
    /(<svg[^>]*)\s+width="[^"]*"/,
    "$1"
  );
  converted = converted.replace(
    /(<svg[^>]*)\s+height="[^"]*"/,
    "$1"
  );

  // Trim whitespace
  converted = converted.trim();

  return `export function ${componentName}({ className = "", ...props }: React.SVGProps<SVGSVGElement>) {
  return (
    ${converted}
  );
}`;
}

function main() {
  console.log("Converting SVG files to React components...\n");

  const components: string[] = [];

  for (const filename of SVG_FILES) {
    const filepath = path.join(PUBLIC_DIR, filename);

    if (!fs.existsSync(filepath)) {
      console.warn(`⚠️  File not found: ${filename}`);
      continue;
    }

    const svgContent = fs.readFileSync(filepath, "utf-8");
    const componentName = toComponentName(filename);

    // Skip very large files (likely contain embedded images)
    if (svgContent.length > 50000) {
      console.warn(`⚠️  Skipping ${filename} (too large: ${Math.round(svgContent.length / 1024)}KB)`);
      continue;
    }

    const component = svgToComponent(svgContent, componentName);
    components.push(component);
    console.log(`✓  ${filename} → ${componentName}`);
  }

  // Generate the output file
  const output = `// Auto-generated by scripts/svg-to-tsx.ts
// Do not edit manually - run the script to regenerate

import * as React from "react";

${components.join("\n\n")}
`;

  fs.writeFileSync(OUTPUT_FILE, output);
  console.log(`\n✓  Generated ${OUTPUT_FILE}`);
}

main();
