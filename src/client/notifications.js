// ============================================
// Notifications
// ============================================

export function showNotif(text, type = 'attention') {
  const c = document.getElementById('notifications');
  const el = document.createElement('div'); el.className = `notification ${type}`; el.textContent = text;
  c.appendChild(el); setTimeout(() => { el.classList.add('fade-out'); setTimeout(() => el.remove(), 300); }, 3000);
}
