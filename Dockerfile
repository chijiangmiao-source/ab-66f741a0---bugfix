# 故障闭环审计页 —— 单镜像 Node 运行（无外部依赖）
FROM node:20-alpine

WORKDIR /app

# 先拷贝清单（本项目无第三方依赖，npm ci 仅用于利用缓存层）
COPY package.json ./
COPY server.js ./
COPY src ./src
COPY public ./public
COPY scripts ./scripts
COPY test ./test

ENV NODE_ENV=production
ENV PORT=8080
ENV HOST=0.0.0.0

EXPOSE 8080

# 健康检查：直接请求审计页的 /healthz（端口随 PORT 可调）
HEALTHCHECK --interval=10s --timeout=3s --start-period=5s --retries=5 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server.js"]
