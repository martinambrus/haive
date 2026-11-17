# syntax=docker/dockerfile:1
FROM --platform=$BUILDPLATFORM node:26-alpine AS ui
WORKDIR /ui
COPY ui/package.json ui/package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY ui/ ./
RUN npm run build

FROM --platform=$BUILDPLATFORM golang:1.25-alpine AS bridge
WORKDIR /src
ENV CGO_ENABLED=0 GOMAXPROCS=2
COPY bridge/ ./
COPY install/ ./install/
RUN go test -p 1 -v ./...
RUN for arch in amd64 arm64; do \
      for os in linux darwin windows; do \
        mkdir -p /out/$arch/$os; \
        suffix=""; if [ "$os" = windows ]; then suffix=.exe; fi; \
        GOOS=$os GOARCH=$arch go build -p 1 -trimpath -ldflags="-s -w" -o /out/$arch/$os/haive-desktop$suffix . || exit 1; \
      done; \
    done

FROM scratch
LABEL org.opencontainers.image.title="Haive" \
    org.opencontainers.image.description="Install and manage a local Haive release using the existing RUN-IT installer." \
    org.opencontainers.image.vendor="Haive" \
    org.opencontainers.image.source="https://github.com/martinambrus/haive" \
    com.docker.desktop.extension.api.version=">= 0.4.2, < 0.5.0" \
    com.docker.desktop.extension.icon="https://raw.githubusercontent.com/martinambrus/haive/main/packages/web/src/app/icon.svg" \
    com.docker.extension.screenshots="[]" \
    com.docker.extension.detailed-description="Install, start and stop Haive using its published compose bundle. The worker mounts the Docker socket with host-root-equivalent access; explicit consent is required before install or start. Extension removal keeps the stack and all data. Public releases only." \
    com.docker.extension.publisher-url="https://github.com/martinambrus/haive" \
    com.docker.extension.additional-urls='[{"title":"Releases","url":"https://github.com/martinambrus/haive/releases"}]' \
    com.docker.extension.changelog="Initial local development extension using the existing installer and first-run setup." \
    com.docker.extension.categories="container-orchestration,utility-tools"
COPY metadata.json icon.svg /
COPY --from=ui /ui/dist /ui
ARG TARGETARCH
COPY --from=bridge /out/${TARGETARCH}/ /
