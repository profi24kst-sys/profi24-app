FROM node:22-alpine
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY --chown=node:node src ./src
COPY --chown=node:node docker-entrypoint.sh /usr/local/bin/profi24-entrypoint
# Windows checkouts may still reach Docker with CRLF despite local Git settings.
# Normalize the shebang inside the image so Linux never looks for `/bin/sh\r`.
RUN sed -i 's/\r$//' /usr/local/bin/profi24-entrypoint && chmod 755 /usr/local/bin/profi24-entrypoint
RUN mkdir -p /data/uploads && chown -R node:node /app /data
USER node
EXPOSE 8080
ENTRYPOINT ["/usr/local/bin/profi24-entrypoint"]
CMD ["npm","start"]
