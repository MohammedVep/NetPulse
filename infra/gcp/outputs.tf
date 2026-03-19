output "project_id" {
  value = google_project.netpulse.project_id
}

output "project_name" {
  value = google_project.netpulse.name
}

output "artifact_repository" {
  value = google_artifact_registry_repository.containers.id
}

output "enabled_services" {
  value = sort([for service in google_project_service.services : service.service])
}
