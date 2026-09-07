FROM node:22-alpine
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY --chown=node:node src ./src
COPY --chmod=755 --chown=node:node docker-entrypoint.sh /usr/local/bin/profi24-entrypoint
RUN mkdir -p /data/uploads && chown -R node:node /app /data
USER node
EXPOSE 8080
ENTRYPOINT ["/usr/local/bin/profi24-entrypoint"]
CMD ["npm","start"]
