variable "env_name" {
  type = string
}

variable "project_id" {
  type = string
}

variable "project_name" {
  type    = string
  default = ""
}

variable "billing_account" {
  type = string
}

variable "region" {
  type    = string
  default = "us-central1"
}

variable "artifact_region" {
  type    = string
  default = "us-central1"
}

variable "repository" {
  type    = string
  default = "netpulse"
}

variable "labels" {
  type    = map(string)
  default = {}
}
