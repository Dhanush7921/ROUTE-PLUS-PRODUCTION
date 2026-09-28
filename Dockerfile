# ROUTE+ beta image. Zero npm dependencies, so there is nothing to install:
# the whole build is "copy the source and run it".
FROM node:22-alpine

# Non-root, and the data directory is a VOLUME so the database survives a
# redeploy that replaces this image.
RUN addgroup -S routeplus && adduser -S routeplus -G routeplus \
 && apk add --no-cache su-exec
WORKDIR /app
COPY --chown=routeplus:routeplus package.json ./
COPY --chown=routeplus:routeplus server ./server
COPY --chown=routeplus:routeplus shared ./shared
COPY --chown=routeplus:routeplus web ./web
COPY --chown=routeplus:routeplus dist ./dist
COPY --chown=routeplus:routeplus scripts ./scripts

COPY --chown=routeplus:routeplus docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod +x /usr/local/bin/docker-entrypoint.sh && mkdir -p /data && chown routeplus:routeplus /data
VOLUME ["/data"]

# NOT `USER routeplus`: a platform volume mounted at /data at run time carries
# its own ownership, which would leave a non-root process unable to write. The
# entrypoint starts as root, fixes the directory, then drops to routeplus — so
# the application itself still runs unprivileged.
ENTRYPOINT ["/usr/local/bin/docker-entrypoint.sh"]

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=8080 \
    ROUTE_PLUS_DB=/data/routeplus.sqlite
EXPOSE 8080

# The health endpoint touches the database, so an unhealthy container is one
# that cannot actually serve, not just one that is slow to boot.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/api/health').then(r=>r.json()).then(b=>process.exit(b.ok?0:1)).catch(()=>process.exit(1))"

# npm start already handles SIGTERM gracefully (drain, close the database, exit).
CMD ["node", "--env-file-if-exists=.env", "--disable-warning=ExperimentalWarning", "server/index.js"]
