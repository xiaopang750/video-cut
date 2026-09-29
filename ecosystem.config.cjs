// pm2 配置：npm start 启动，服务端口 3031
module.exports = {
  apps: [
    {
      name: 'video-cut',
      script: 'server/index.js',
      cwd: __dirname,
      env: {
        PORT: 3031,
        NODE_ENV: 'production',
      },
      autorestart: true,
      watch: false,
      max_memory_restart: '3G',
      time: true,
    },
  ],
};
