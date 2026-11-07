import { api, errText } from "./api";
import { useStore } from "./store";

/** Copies text (through Windows' clip.exe inside Hangar) and says so in a toast. */
export function copyText(text: string, said = "Copied") {
  const { toast } = useStore.getState();
  api.clipboardSet(text).then(() => toast(said, "ok"), (e) => toast(errText(e), "bad"));
}
