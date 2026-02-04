// API base URL - uses environment variable or defaults to localhost for development
const API_URL = window.API_URL || 'http://localhost:3001';

// DOM Elements
const statusBadge = document.getElementById('status');
const serverInfoContainer = document.getElementById('server-info');
const itemsContainer = document.getElementById('items-container');
const toast = document.getElementById('toast');

// Show toast notification
function showToast(message, type = 'info') {
  toast.textContent = message;
  toast.className = `toast show ${type}`;
  setTimeout(() => {
    toast.className = 'toast';
  }, 3000);
}

// Update connection status
function updateStatus(connected, message = '') {
  statusBadge.className = `status-badge ${connected ? 'connected' : 'error'}`;
  statusBadge.querySelector('span:last-child').textContent = message || (connected ? 'Connected' : 'Disconnected');
}

// Fetch server info
async function fetchServerInfo() {
  try {
    const response = await fetch(`${API_URL}/api/info`);
    if (!response.ok) throw new Error('Failed to fetch');
    
    const data = await response.json();
    updateStatus(true, 'Connected');
    
    serverInfoContainer.innerHTML = `
      <h3>🖥️ Server Info</h3>
      <div class="info-grid">
        <div class="info-item">
          <div class="label">Service</div>
          <div class="value">${data.service}</div>
        </div>
        <div class="info-item">
          <div class="label">Version</div>
          <div class="value">${data.version}</div>
        </div>
        <div class="info-item">
          <div class="label">Pod Name</div>
          <div class="value">${data.podName}</div>
        </div>
        <div class="info-item">
          <div class="label">Environment</div>
          <div class="value">${data.nodeEnv}</div>
        </div>
      </div>
    `;
  } catch (error) {
    console.error('Error fetching server info:', error);
    updateStatus(false, 'Connection Failed');
    serverInfoContainer.innerHTML = `
      <h3>🖥️ Server Info</h3>
      <div class="info-grid">
        <div class="info-item">
          <div class="label">Status</div>
          <div class="value" style="color: var(--accent-magenta)">Unable to connect to backend</div>
        </div>
      </div>
    `;
  }
}

// Fetch items
async function fetchItems() {
  try {
    const response = await fetch(`${API_URL}/api/items`);
    if (!response.ok) throw new Error('Failed to fetch');
    
    const data = await response.json();
    
    itemsContainer.innerHTML = data.items.map(item => `
      <div class="item-card">
        <div class="icon">${item.icon}</div>
        <div class="name">${item.name}</div>
        <div class="description">${item.description}</div>
      </div>
    `).join('');
  } catch (error) {
    console.error('Error fetching items:', error);
    itemsContainer.innerHTML = `
      <div class="item-card">
        <div class="icon">⚠️</div>
        <div class="name">Error</div>
        <div class="description">Failed to load items</div>
      </div>
    `;
  }
}

// Refresh all data
async function refreshData() {
  showToast('Refreshing data...', 'info');
  await Promise.all([fetchServerInfo(), fetchItems()]);
  showToast('Data refreshed!', 'success');
}

// Check health endpoint
async function checkHealth() {
  try {
    const response = await fetch(`${API_URL}/health`);
    if (!response.ok) throw new Error('Health check failed');
    
    const data = await response.json();
    showToast(`✓ Backend healthy: ${data.timestamp}`, 'success');
  } catch (error) {
    showToast('✗ Backend health check failed', 'error');
  }
}

// Initialize app
document.addEventListener('DOMContentLoaded', () => {
  refreshData();
});

// Expose functions to window for onclick handlers
window.refreshData = refreshData;
window.checkHealth = checkHealth;


