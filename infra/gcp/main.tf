locals {
  resolved_project_name = trimspace(var.project_name) != "" ? var.project_name : "NetPulse Multicloud ${title(var.env_name)}"
  labels = merge(
    {
      app       = "netpulse"
      env       = var.env_name
      managedby = "terraform"
    },
    var.labels
  )
  enabled_services = toset([
    "cloudresourcemanager.googleapis.com",
    "serviceusage.googleapis.com",
    "artifactregistry.googleapis.com",
    "run.googleapis.com"
  ])
}

resource "google_project" "netpulse" {
  project_id          = var.project_id
  name                = local.resolved_project_name
  billing_account     = var.billing_account
  auto_create_network = true
  labels              = local.labels

  lifecycle {
    ignore_changes = [auto_create_network]
  }
}

resource "google_project_service" "services" {
  for_each = local.enabled_services

  project            = google_project.netpulse.project_id
  service            = each.value
  disable_on_destroy = false
}

resource "google_artifact_registry_repository" "containers" {
  project       = google_project.netpulse.project_id
  location      = var.artifact_region
  repository_id = var.repository
  description   = "NetPulse multi-cloud runtime images"
  format        = "DOCKER"

  depends_on = [google_project_service.services["artifactregistry.googleapis.com"]]
}
