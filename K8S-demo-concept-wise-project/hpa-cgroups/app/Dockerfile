FROM node:20-alpine
WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev
COPY server.js ./
EXPOSE 3000
# --expose-gc lets /free-mem actually return memory to the OS, so you can
# watch memory.current fall again after an allocation spike.
CMD ["node", "--expose-gc", "server.js"]
