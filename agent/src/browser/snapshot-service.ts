import type { Page } from "playwright";
import { refStore, type LocatorDescriptor } from "./ref-store";

export class SnapshotService {
  async generate(page: Page, targetId: string): Promise<{ snapshotId: string; text: string }> {
    const snapshotId = refStore.createSnapshot(targetId);
    
    let rawSnapshot = "";
    try {
      rawSnapshot = await (page.locator("body") as any).ariaSnapshot();
    } catch (err) {
      return { snapshotId, text: `(Failed to capture snapshot: ${err instanceof Error ? err.message : String(err)})` };
    }

    if (!rawSnapshot) {
      return { snapshotId, text: "(Empty Page)" };
    }

    const lines = rawSnapshot.split("\n");
    const parsedLines: string[] = [];
    let refCounter = 0;

    const interactiveRoles = [
      "button", "link", "textbox", "checkbox", "combobox", 
      "listbox", "radio", "searchbox", "slider", "spinbutton", 
      "switch", "tab", "menuitem"
    ];

    for (const line of lines) {
      // Regex 1: Matches - role "name" [attributes] or - role "name": value
      let match = line.match(/^(\s*)-\s+(\w+)\s+"([^"]*)"(?:\s*:\s*([^\[]*))?(?:\s+\[(.*)\])?$/);
      let indent = "";
      let role = "";
      let name = "";
      let value = "";
      let attributes = "";
      let isMatched = false;

      if (match) {
        indent = match[1];
        role = match[2];
        name = match[3];
        value = (match[4] || "").trim();
        attributes = (match[5] || "").trim();
        isMatched = true;
      } else {
        // Regex 2: Matches - role: value or - role
        const noQuoteMatch = line.match(/^(\s*)-\s+(\w+)(?:\s*:\s*(.*))$/);
        if (noQuoteMatch) {
          indent = noQuoteMatch[1];
          role = noQuoteMatch[2];
          name = "";
          value = (noQuoteMatch[3] || "").trim();
          attributes = "";
          isMatched = true;
        }
      }

      if (isMatched) {
        const isInteractive = interactiveRoles.includes(role);
        if (isInteractive) {
          refCounter += 1;
          const refId = `e${refCounter}`;

          const descriptor: LocatorDescriptor = {
            role,
            name,
          };
          refStore.saveRef(snapshotId, refId, descriptor);

          let attrStr = `ref=${refId}`;
          if (attributes) {
            attrStr = `${attributes} ${attrStr}`;
          }

          const valStr = value ? `: ${value}` : "";
          if (name) {
            parsedLines.push(`${indent}- ${role} "${name}"${valStr} [${attrStr}]`);
          } else {
            parsedLines.push(`${indent}- ${role}${valStr} [${attrStr}]`);
          }
        } else {
          parsedLines.push(line);
        }
      } else {
        parsedLines.push(line);
      }
    }

    return {
      snapshotId,
      text: parsedLines.join("\n"),
    };
  }
}
