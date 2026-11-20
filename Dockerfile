FROM ghcr.io/cirruslabs/android-sdk:35@sha256:c724009e305b4607157287624033ab97f319af44c244bfc9f73b6293f3bb01b9 AS android
WORKDIR /src
COPY sdks/android .
RUN ./gradlew --no-daemon assembleRelease

FROM node:24-bookworm AS dashboard
WORKDIR /src
RUN apt-get update && apt-get install -y --no-install-recommends zip && rm -rf /var/lib/apt/lists/*
COPY . .
COPY --from=android /src/build/outputs/aar/birdwatch-android-release.aar sdks/android/build/outputs/aar/
RUN make js-sdk && node sdks/artifacts.mjs --pack && npm run build --workspace birdwatch-ui

FROM golang:1.26-bookworm AS server
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY cmd cmd
COPY internal internal
COPY --from=dashboard /src/static static
COPY --from=dashboard /src/ui/public/assets ui/public/assets
RUN go run ./internal/dashboard/generate.go && CGO_ENABLED=0 go build -trimpath -o /birdwatch ./cmd/birdwatch
RUN mkdir -p /runtime/data /runtime/tmp && chmod 0700 /runtime/data /runtime/tmp

FROM scratch
COPY --from=server /etc/ssl/certs/ca-certificates.crt /etc/ssl/certs/
COPY --from=server --chown=10001:10001 /runtime/ /
COPY --from=server /birdwatch /birdwatch
COPY LICENSE THIRD_PARTY_NOTICES.txt /licenses/
USER 10001:10001
ENV BIRDWATCH_HOST=0.0.0.0 BIRDWATCH_DB=/data/birdwatch.sqlite3
VOLUME ["/data"]
EXPOSE 8123
ENTRYPOINT ["/birdwatch"]
