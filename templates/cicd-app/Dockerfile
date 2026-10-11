FROM node:22-alpine
WORKDIR /app
COPY package.json release.json server.js ./
USER node
EXPOSE 8080
HEALTHCHECK --interval=5s --timeout=2s --start-period=5s --retries=3 CMD node -e "fetch('http://127.0.0.1:8080/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node","server.js"]
