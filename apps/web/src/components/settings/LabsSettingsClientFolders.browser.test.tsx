import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";

import { render } from "../../../test/render";
import { removeLocalStorageItem, setLocalStorageItem } from "../../hooks/useLocalStorage";
import { CLIENT_FOLDERS_ENABLED_KEY } from "../sidebar/clientFolders";
import { CLIENT_FOLDER_ORDER_KEY, SidebarClientFolderOrder } from "../sidebar/clientFolderOrder";
import { BoringSidebarClientFoldersRow } from "./LabsSettingsPanel";

describe("BoringSidebarClientFoldersRow", () => {
  it("resets a stored folder order, and offers no reset without one", async () => {
    using stack = new DisposableStack();
    stack.defer(() => removeLocalStorageItem(CLIENT_FOLDERS_ENABLED_KEY));
    stack.defer(() => removeLocalStorageItem(CLIENT_FOLDER_ORDER_KEY));
    setLocalStorageItem(CLIENT_FOLDERS_ENABLED_KEY, true, Schema.Boolean);
    setLocalStorageItem(
      CLIENT_FOLDER_ORDER_KEY,
      { rail: ["client:Globex", "client:Acme"] },
      SidebarClientFolderOrder,
    );
    await using screen = await render(<BoringSidebarClientFoldersRow />);
    const reset = screen.getByRole("button", { name: /folder order/i });
    await expect.element(reset).toBeInTheDocument();

    await userEvent.click(reset);
    await expect.element(reset).not.toBeInTheDocument();
    expect(JSON.parse(localStorage.getItem(CLIENT_FOLDER_ORDER_KEY) ?? "null")).toEqual({});
  });
});
