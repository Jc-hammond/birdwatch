package server

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"net/http"
	"strconv"

	"github.com/Jc-hammond/birdwatch/internal/storage"
)

func (s *Server) changeProject(r *http.Request) (any, error) {
	id, err := strconv.ParseInt(r.PathValue("project"), 10, 64)
	if err != nil {
		return nil, badParam("project")
	}
	var days *int64
	if r.Method == http.MethodPatch {
		body, err := readObject(r)
		if err != nil {
			return nil, err
		}
		raw, ok := body["retention_days"]
		if !ok || len(body) != 1 || json.Unmarshal(raw, &days) != nil || (days != nil && *days < 1) {
			return nil, badParam("retention_days")
		}
	}
	var result record
	err = s.db.Write(r.Context(), func(ctx context.Context, tx *sql.Tx) error {
		var sample bool
		err := tx.QueryRowContext(ctx, "SELECT sample_as_of IS NOT NULL FROM projects WHERE id=?", id).Scan(&sample)
		if errors.Is(err, sql.ErrNoRows) {
			return failure{404, "not_found", "Project not found. Check the project ID."}
		}
		if err != nil {
			return err
		}
		if sample {
			return failure{403, "forbidden", "The sample project is read-only."}
		}
		if r.Method == http.MethodPatch {
			_, err = tx.ExecContext(ctx, "UPDATE projects SET retention_days=? WHERE id=?", days, id)
			result = record{"retention_days": days}
			return err
		}
		removed, err := storage.ErasePerson(ctx, tx, id, r.PathValue("person"))
		result = record{"removed": removed}
		return err
	})
	return result, err
}
