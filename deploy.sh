#!/bin/bash

# K8s Demo App - Deployment Script
# This script builds Docker images and deploys to local Kubernetes

set -e

echo "🚀 K8s Demo App - Local Deployment"
echo "=================================="

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# Check prerequisites
check_prerequisites() {
    echo -e "\n${YELLOW}Checking prerequisites...${NC}"
    
    if ! command -v docker &> /dev/null; then
        echo -e "${RED}Error: Docker is not installed${NC}"
        exit 1
    fi
    
    if ! command -v kubectl &> /dev/null; then
        echo -e "${RED}Error: kubectl is not installed${NC}"
        exit 1
    fi
    
    # Check if using minikube or Docker Desktop
    if command -v minikube &> /dev/null; then
        echo -e "${GREEN}✓ Minikube detected${NC}"
        PLATFORM="minikube"
    elif kubectl config current-context | grep -q "docker-desktop"; then
        echo -e "${GREEN}✓ Docker Desktop Kubernetes detected${NC}"
        PLATFORM="docker-desktop"
    else
        echo -e "${YELLOW}⚠ Unknown Kubernetes platform. Assuming Docker Desktop.${NC}"
        PLATFORM="docker-desktop"
    fi
    
    echo -e "${GREEN}✓ All prerequisites met${NC}"
}

# Build Docker images
build_images() {
    echo -e "\n${YELLOW}Building Docker images...${NC}"
    
    if [ "$PLATFORM" == "minikube" ]; then
        echo "Setting up Minikube Docker environment..."
        eval $(minikube docker-env)
    fi
    
    # Build backend
    echo "Building backend image..."
    docker build -t k8s-demo-backend:latest ./backend
    
    # Build frontend
    echo "Building frontend image..."
    docker build -t k8s-demo-frontend:latest ./frontend
    
    echo -e "${GREEN}✓ Docker images built successfully${NC}"
}

# Deploy to Kubernetes
deploy() {
    echo -e "\n${YELLOW}Deploying to Kubernetes...${NC}"
    
    # Create namespace
    kubectl apply -f k8s/namespace.yaml
    
    # Apply configurations
    kubectl apply -f k8s/configmap.yaml
    kubectl apply -f k8s/backend-deployment.yaml
    kubectl apply -f k8s/frontend-deployment.yaml
    
    # Optional: Apply ingress if nginx ingress controller is available
    if kubectl get ingressclass nginx &> /dev/null; then
        echo "Applying Ingress..."
        kubectl apply -f k8s/ingress.yaml
    else
        echo -e "${YELLOW}⚠ NGINX Ingress Controller not found. Skipping ingress setup.${NC}"
    fi
    
    echo -e "${GREEN}✓ Deployment complete${NC}"
}

# Wait for pods to be ready
wait_for_pods() {
    echo -e "\n${YELLOW}Waiting for pods to be ready...${NC}"
    kubectl wait --for=condition=ready pod -l app=backend -n k8s-demo --timeout=120s
    kubectl wait --for=condition=ready pod -l app=frontend -n k8s-demo --timeout=120s
    echo -e "${GREEN}✓ All pods are ready${NC}"
}

# Get access URLs
get_urls() {
    echo -e "\n${YELLOW}Access URLs:${NC}"
    echo "=================================="
    
    if [ "$PLATFORM" == "minikube" ]; then
        FRONTEND_URL=$(minikube service frontend -n k8s-demo --url 2>/dev/null || echo "Run: minikube service frontend -n k8s-demo")
        BACKEND_URL=$(minikube service backend -n k8s-demo --url 2>/dev/null || echo "Run: minikube service backend -n k8s-demo")
        echo -e "Frontend: ${GREEN}${FRONTEND_URL}${NC}"
        echo -e "Backend:  ${GREEN}${BACKEND_URL}${NC}"
    else
        # Get NodePort
        FRONTEND_PORT=$(kubectl get svc frontend -n k8s-demo -o jsonpath='{.spec.ports[0].nodePort}')
        echo -e "Frontend: ${GREEN}http://localhost:${FRONTEND_PORT}${NC}"
        echo ""
        echo "Or use port-forwarding:"
        echo -e "  kubectl port-forward svc/frontend 3000:3000 -n k8s-demo"
        echo -e "  kubectl port-forward svc/backend 3001:3001 -n k8s-demo"
    fi
    
    echo ""
    echo "Useful commands:"
    echo "  kubectl get pods -n k8s-demo"
    echo "  kubectl logs -f deployment/backend -n k8s-demo"
    echo "  kubectl logs -f deployment/frontend -n k8s-demo"
}

# Main execution
main() {
    check_prerequisites
    build_images
    deploy
    wait_for_pods
    get_urls
    
    echo -e "\n${GREEN}🎉 Deployment successful!${NC}"
}

# Handle cleanup
cleanup() {
    echo -e "\n${YELLOW}Cleaning up...${NC}"
    kubectl delete namespace k8s-demo --ignore-not-found
    echo -e "${GREEN}✓ Cleanup complete${NC}"
}

# Parse arguments
case "${1:-}" in
    "cleanup"|"clean"|"delete")
        cleanup
        ;;
    *)
        main
        ;;
esac


