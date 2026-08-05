FROM node:22-alpine AS web
WORKDIR /src/web
COPY web/package.json ./
RUN npm install
COPY web/ ./
RUN npm run build

FROM golang:1.23-alpine AS go
WORKDIR /src
COPY go.mod ./
COPY cmd/ ./cmd/
COPY pkg/ ./pkg/
RUN CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /out/safast-server ./cmd/safast-server

FROM gcr.io/distroless/static-debian12:nonroot
COPY --from=go /out/safast-server /safast-server
COPY --from=web /src/web/dist /web
EXPOSE 8080
ENTRYPOINT ["/safast-server", "-addr", ":8080", "-dir", "/web"]
