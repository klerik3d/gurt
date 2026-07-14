// Package engine defines gurt's boundary to dev container execution.
//
// The interface is deliberately narrow and is the stable seam between gurt
// and whatever brings containers up. The first implementation (devcli) wraps
// the official devcontainer CLI to start fast; once go-devcontainer's runner
// package lands, it becomes the second implementation and devcli goes away.
package engine

import (
	"context"
	"io"
)

// Ref addresses one environment: the workspace folder on the host plus the
// identity labels gurt stamps on the container (gurt.workspace, gurt.task,
// gurt.repo, gurt.envtype). Implementations must both set the labels on
// created containers and use them to find existing ones.
type Ref struct {
	// WorkspaceFolder is the host path of the cloned repository.
	WorkspaceFolder string
	// ConfigPath optionally points at the devcontainer.json to use instead
	// of the workspace's own; gurt passes the composed effective config
	// (base overlaid with features and env-type variables) here.
	ConfigPath string
	// Labels identify the container.
	Labels map[string]string
}

// UpRequest describes an environment to bring up or attach to.
type UpRequest struct {
	Ref
	// AdditionalFeatures are devcontainer features merged into the config
	// on top of what it declares (how gurt injects vsc/claude), keyed by
	// feature reference with the feature's options as value.
	AdditionalFeatures map[string]any
	// RemoteEnv is extra environment applied to exec'd processes.
	RemoteEnv map[string]string
	// Progress, when non-nil, receives the build/up log as it happens.
	Progress io.Writer
}

// Environment is the result of a successful Up.
type Environment struct {
	ContainerID           string
	RemoteUser            string
	RemoteWorkspaceFolder string
}

// ExecSpec is one process to run inside an environment, as the environment's
// remote user with its remote env applied. Stdio streams may be nil.
type ExecSpec struct {
	Argv []string
	// Env is extra environment for this process only.
	Env map[string]string
	// Dir is the working directory; empty means the remote workspace folder.
	Dir    string
	Stdin  io.Reader
	Stdout io.Writer
	Stderr io.Writer
}

// Process is a started exec.
type Process interface {
	// Wait blocks until the process exits and returns its failure, if any.
	Wait() error
	// Kill terminates the process.
	Kill() error
}

// Container is a discovered container.
type Container struct {
	ID      string
	Running bool
	Labels  map[string]string
}

// Engine brings dev container environments up and runs processes in them.
type Engine interface {
	// Up creates the environment, or attaches to an existing container
	// carrying the same identity labels.
	Up(ctx context.Context, req UpRequest) (*Environment, error)
	// Exec starts a process inside a previously upped environment.
	Exec(ctx context.Context, ref Ref, spec ExecSpec) (Process, error)
	// Find returns containers whose labels include every given label.
	Find(ctx context.Context, labels map[string]string) ([]Container, error)
	// Stop stops a container. Nothing is ever removed implicitly; stopping
	// is always an explicit user action (see CONCEPT.md).
	Stop(ctx context.Context, containerID string) error
}
