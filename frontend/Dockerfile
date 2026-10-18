# Build from the repository root: shared stadium geometry lives outside frontend/.
ARG NODE_IMAGE=node:24-alpine
ARG NGINX_IMAGE=nginxinc/nginx-unprivileged:1.30-alpine

FROM ${NODE_IMAGE} AS dependencies
WORKDIR /app/frontend
RUN chown -R node:node /app
USER node
COPY --chown=node:node frontend/package.json frontend/package-lock.json ./
RUN npm ci --no-audit --no-fund

FROM dependencies AS development
COPY --chown=node:node frontend/ ./
COPY --chown=node:node shared/ /app/shared/
EXPOSE 5173
CMD ["npm", "run", "dev", "--", "--host", "0.0.0.0", "--strictPort"]

FROM development AS build
# Optional external endpoints are public build-time configuration, never secrets.
# Empty values keep browser traffic on the same origin as the frontend.
ARG VITE_API_URL=""
ARG VITE_CONGESTION_WS_URL=""
ENV VITE_API_URL=${VITE_API_URL} \
    VITE_CONGESTION_WS_URL=${VITE_CONGESTION_WS_URL}
RUN npm run build

FROM ${NGINX_IMAGE} AS runtime
COPY frontend/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/frontend/dist /usr/share/nginx/html
USER 101:101
EXPOSE 8080
HEALTHCHECK --interval=15s --timeout=3s --start-period=5s --retries=3 \
    CMD wget -q -O /dev/null http://127.0.0.1:8080/health || exit 1
# Configuration is static; avoid entrypoint scripts that edit a read-only rootfs.
ENTRYPOINT ["nginx"]
CMD ["-g", "daemon off;"]

