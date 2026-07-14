// Package devcli implements engine.Engine by wrapping the official
// devcontainer CLI (github.com/devcontainers/cli), plus the docker CLI for
// discovery and stopping, which the devcontainer CLI does not cover.
//
// This is the interim engine with no go-devcontainer dependency: the CLI
// composes the config itself (--additional-features for injected features,
// --override-config for gurt templates, --remote-env for env-type
// variables), identity labels travel via --id-label so containers stay
// discoverable with plain docker label filters. The whole package is
// replaced by go-devcontainer's runner when that lands.
package devcli

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os/exec"
	"sort"
	"strings"

	"github.com/klerik3d/gurt/internal/engine"
)

// Engine shells out to the devcontainer and docker CLIs.
type Engine struct {
	// DevcontainerBin and DockerBin name the executables to run; empty
	// values mean "devcontainer" and "docker" from PATH.
	DevcontainerBin string
	DockerBin       string
}

var _ engine.Engine = (*Engine)(nil)

func (e *Engine) devcontainer() string {
	if e.DevcontainerBin != "" {
		return e.DevcontainerBin
	}
	return "devcontainer"
}

func (e *Engine) docker() string {
	if e.DockerBin != "" {
		return e.DockerBin
	}
	return "docker"
}

// Check verifies the devcontainer CLI is runnable and returns its version.
func (e *Engine) Check(ctx context.Context) (string, error) {
	out, err := exec.CommandContext(ctx, e.devcontainer(), "--version").Output()
	if err != nil {
		return "", fmt.Errorf("devcontainer CLI not available (npm install -g @devcontainers/cli): %w", cmdErr(err))
	}
	return strings.TrimSpace(string(out)), nil
}

func (e *Engine) Up(ctx context.Context, req engine.UpRequest) (*engine.Environment, error) {
	args := []string{"up", "--workspace-folder", req.WorkspaceFolder}
	if req.ConfigPath != "" {
		args = append(args, "--override-config", req.ConfigPath)
	}
	if len(req.AdditionalFeatures) > 0 {
		features, err := json.Marshal(req.AdditionalFeatures)
		if err != nil {
			return nil, fmt.Errorf("devcli: encoding additional features: %w", err)
		}
		args = append(args, "--additional-features", string(features))
	}
	args = append(args, pairArgs("--id-label", req.Labels)...)
	args = append(args, pairArgs("--remote-env", req.RemoteEnv)...)

	cmd := exec.CommandContext(ctx, e.devcontainer(), args...)
	var stdout bytes.Buffer
	cmd.Stdout = &stdout
	cmd.Stderr = io.Discard
	if req.Progress != nil {
		cmd.Stderr = req.Progress
	}
	runErr := cmd.Run()

	// The CLI reports the outcome as a JSON object on stdout (logs go to
	// stderr) for successes and failures alike, so prefer that over the
	// exit code.
	res, parseErr := parseUpResult(stdout.Bytes())
	switch {
	case parseErr != nil && runErr != nil:
		return nil, fmt.Errorf("devcontainer up: %w", runErr)
	case parseErr != nil:
		return nil, fmt.Errorf("devcontainer up: %w", parseErr)
	case res.Outcome != "success":
		msg := res.Description
		if msg == "" {
			msg = res.Message
		}
		if msg == "" {
			msg = "unknown error"
		}
		return nil, fmt.Errorf("devcontainer up: %s", msg)
	}
	return &engine.Environment{
		ContainerID:           res.ContainerID,
		RemoteUser:            res.RemoteUser,
		RemoteWorkspaceFolder: res.RemoteWorkspaceFolder,
	}, nil
}

func (e *Engine) Exec(ctx context.Context, ref engine.Ref, spec engine.ExecSpec) (engine.Process, error) {
	if len(spec.Argv) == 0 {
		return nil, errors.New("devcli: exec needs a command")
	}
	args := []string{"exec", "--workspace-folder", ref.WorkspaceFolder}
	if ref.ConfigPath != "" {
		args = append(args, "--override-config", ref.ConfigPath)
	}
	args = append(args, pairArgs("--id-label", ref.Labels)...)
	args = append(args, pairArgs("--remote-env", spec.Env)...)
	args = append(args, execArgv(spec)...)

	cmd := exec.CommandContext(ctx, e.devcontainer(), args...)
	cmd.Stdin = spec.Stdin
	cmd.Stdout = spec.Stdout
	cmd.Stderr = spec.Stderr
	if err := cmd.Start(); err != nil {
		return nil, fmt.Errorf("devcontainer exec: %w", err)
	}
	return process{cmd}, nil
}

// execArgv returns the command to pass to `devcontainer exec`. The CLI has
// no working-directory flag, so a non-empty Dir hops through a shell.
func execArgv(spec engine.ExecSpec) []string {
	if spec.Dir == "" {
		return spec.Argv
	}
	return append([]string{"/bin/sh", "-c", `cd "$0" && exec "$@"`, spec.Dir}, spec.Argv...)
}

func (e *Engine) Find(ctx context.Context, labels map[string]string) ([]engine.Container, error) {
	args := []string{"ps", "--all", "--quiet", "--no-trunc"}
	keys := make([]string, 0, len(labels))
	for k := range labels {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	for _, k := range keys {
		args = append(args, "--filter", "label="+k+"="+labels[k])
	}
	out, err := exec.CommandContext(ctx, e.docker(), args...).Output()
	if err != nil {
		return nil, fmt.Errorf("docker ps: %w", cmdErr(err))
	}
	ids := strings.Fields(string(out))
	if len(ids) == 0 {
		return nil, nil
	}
	out, err = exec.CommandContext(ctx, e.docker(), append([]string{"inspect"}, ids...)...).Output()
	if err != nil {
		return nil, fmt.Errorf("docker inspect: %w", cmdErr(err))
	}
	return decodeInspect(out)
}

func (e *Engine) Stop(ctx context.Context, containerID string) error {
	if _, err := exec.CommandContext(ctx, e.docker(), "stop", containerID).Output(); err != nil {
		return fmt.Errorf("docker stop: %w", cmdErr(err))
	}
	return nil
}

type process struct{ cmd *exec.Cmd }

func (p process) Wait() error { return p.cmd.Wait() }
func (p process) Kill() error { return p.cmd.Process.Kill() }

// upResult is the JSON object `devcontainer up` prints on stdout.
type upResult struct {
	Outcome               string `json:"outcome"`
	Message               string `json:"message"`
	Description           string `json:"description"`
	ContainerID           string `json:"containerId"`
	RemoteUser            string `json:"remoteUser"`
	RemoteWorkspaceFolder string `json:"remoteWorkspaceFolder"`
}

// parseUpResult finds the outcome object in the CLI's stdout, scanning from
// the end so stray output ahead of it is tolerated.
func parseUpResult(out []byte) (*upResult, error) {
	lines := bytes.Split(bytes.TrimSpace(out), []byte("\n"))
	for i := len(lines) - 1; i >= 0; i-- {
		line := bytes.TrimSpace(lines[i])
		if len(line) == 0 || line[0] != '{' {
			continue
		}
		var res upResult
		if err := json.Unmarshal(line, &res); err == nil && res.Outcome != "" {
			return &res, nil
		}
	}
	return nil, fmt.Errorf("no outcome object in output %q", truncate(string(out), 200))
}

func decodeInspect(data []byte) ([]engine.Container, error) {
	var raw []struct {
		ID    string `json:"Id"`
		State struct {
			Running bool `json:"Running"`
		} `json:"State"`
		Config struct {
			Labels map[string]string `json:"Labels"`
		} `json:"Config"`
	}
	if err := json.Unmarshal(data, &raw); err != nil {
		return nil, fmt.Errorf("docker inspect: %w", err)
	}
	containers := make([]engine.Container, len(raw))
	for i, r := range raw {
		containers[i] = engine.Container{ID: r.ID, Running: r.State.Running, Labels: r.Config.Labels}
	}
	return containers, nil
}

// pairArgs renders a map as repeated `flag key=value` arguments, sorted for
// determinism.
func pairArgs(flag string, m map[string]string) []string {
	keys := make([]string, 0, len(m))
	for k := range m {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	args := make([]string, 0, 2*len(keys))
	for _, k := range keys {
		args = append(args, flag, k+"="+m[k])
	}
	return args
}

// cmdErr surfaces the command's stderr, which Output captures in ExitError.
func cmdErr(err error) error {
	var xe *exec.ExitError
	if errors.As(err, &xe) && len(xe.Stderr) > 0 {
		return fmt.Errorf("%w: %s", err, strings.TrimSpace(string(xe.Stderr)))
	}
	return err
}

func truncate(s string, n int) string {
	if len(s) <= n {
		return s
	}
	return s[:n] + "..."
}
