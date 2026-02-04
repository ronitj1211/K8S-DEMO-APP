const express = require('express');
const cors = require('cors');

const app = express();
const PORT = process.env.PORT || 3001;

app.use(cors());
app.use(express.json());

// Sample data
const items = [
  { id: 1, name: 'Kubernetes', description: 'Container orchestration platform', icon: '☸️' },
  { id: 2, name: 'Docker', description: 'Containerization technology', icon: '🐳' },
  { id: 3, name: 'Node.js', description: 'JavaScript runtime', icon: '💚' },
  { id: 4, name: 'React', description: 'Frontend library', icon: '⚛️' },
];

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({ status: 'healthy', timestamp: new Date().toISOString() });
});

// API endpoints
app.get('/api/items', (req, res) => {
  res.json({ items, count: items.length });
});

app.get('/api/items/:id', (req, res) => {
  const item = items.find(i => i.id === parseInt(req.params.id));
  if (!item) {
    return res.status(404).json({ error: 'Item not found' });
  }
  res.json(item);
});

app.get('/api/info', (req, res) => {
  res.json({
    service: 'k8s-demo-backend',
    version: '1.0.0',
    hostname: process.env.HOSTNAME || 'unknown',
    podName: process.env.POD_NAME || 'local',
    nodeEnv: process.env.NODE_ENV || 'development',
  });
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 Backend server running on port ${PORT}`);
});


