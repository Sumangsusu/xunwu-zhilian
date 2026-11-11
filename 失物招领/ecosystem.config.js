module.exports = {
  apps: [{
    name: 'xunwu-zhilian',
    cwd: __dirname,
    script: 'server.js',
    instances: 1,
    exec_mode: 'fork',
    autorestart: true,
    max_restarts: 5,
    restart_delay: 2000,
    env: { NODE_ENV: 'production', HOST: '127.0.0.1' }
  }]
};
