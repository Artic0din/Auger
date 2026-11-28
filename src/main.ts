import { boot } from "./bootstrap.ts";
import "./theme.css";
import "./app.css";
import "./ui/signIn.css";
import "./ui/browse.css";
import "./ui/confirmationDialog.css";
import "./ui/accounts.css";
import "./player/player.css";
import "./player/audiobookPlayer.css";

const root = document.getElementById("screen");
if (root === null) {
    throw new Error("Auger's screen is missing");
}
export const app = boot(root, APP_VERSION);
