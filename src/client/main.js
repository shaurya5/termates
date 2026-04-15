import { connectWs } from './transport.js';
import { setupDialogEvents } from './dialogs.js';
import { setupKeys } from './keyboard.js';
import { renderLayout } from './layout/renderer.js';
import { setupUI } from './ui-setup.js';
import './update.js';

// ============================================
// Init
// ============================================
setupUI();
setupDialogEvents();
setupKeys();
renderLayout();
connectWs();
